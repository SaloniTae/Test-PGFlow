require('dotenv').config();
const express = require('express');
const { Redis } = require('@upstash/redis');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURATION (GET FROM ENV VARS ON RENDER) ---
const PORT = process.env.PORT || 3000;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "https://daring-skylark-50103.upstash.io";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "AcO3AAIncDIzNGZiZTE0NmVkNzA0NGVhOGZjNjVkYzZjZTgzNDM1NHAyNTAxMDM";

// PAYTM CONFIG
const PAYTM_MID = process.env.PAYTM_MID || "RZUqNv45112793295319"; 
const UPI_VPA = process.env.UPI_VPA || "paytm.s1a23xv@pty";
const MERCHANT_NAME = "Ayush Gateway";

// DATABASE CONNECTION
const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });

// ================================================================
// PART A: THE GATEWAY API (What you are building)
// ================================================================

// 1. CREATE ORDER (Gateway saves contract)
app.post('/api/create-order', async (req, res) => {
    const { amount, seller_callback_url, seller_return_url } = req.body;

    if (!amount) return res.status(400).json({ error: "Amount required" });

    const orderId = `ORD_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;

    const orderData = {
        amount_expected: amount,
        status: "PENDING",
        callback_url: seller_callback_url,
        return_url: seller_return_url,
        created_at: Date.now()
    };

    // Save to Redis (Auto delete after 30 mins)
    await redis.set(`order:${orderId}`, JSON.stringify(orderData), { ex: 1800 });

    // In production, use your actual Render URL
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    res.json({
        status: "created",
        order_id: orderId,
        payment_url: `${baseUrl}/pay.html?order_id=${orderId}`
    });
});

// 2. GET DETAILS (For QR Generation)
app.get('/api/order-details/:order_id', async (req, res) => {
    const data = await redis.get(`order:${req.params.order_id}`);
    if (!data) return res.status(404).json({ error: "Expired" });

    // Securely generate UPI string on backend
    const upiString = `upi://pay?pa=${UPI_VPA}&am=${data.amount_expected}&pn=${MERCHANT_NAME}&tr=${req.params.order_id}&tn=${req.params.order_id}&cu=INR`;

    res.json({ amount: data.amount_expected, upi_string: upiString });
});

// 3. VERIFY & WEBHOOK (The Security Core)
app.post('/api/verify', async (req, res) => {
    const { order_id } = req.body;
    const data = await redis.get(`order:${order_id}`);
    
    if (!data) return res.status(404).json({ error: "Order not found" });
    if (data.status === 'SUCCESS') return res.json({ status: "SUCCESS" });

    // --- PAYTM CHECK LOGIC ---
    const paytmParams = { MID: PAYTM_MID, ORDERID: order_id };
    const paytmUrl = `https://securegw.paytm.in/order/status?JsonData=${JSON.stringify(paytmParams)}`;

    try {
        const bankRes = await axios.get(paytmUrl);
        const bankData = bankRes.data; 

        // !!! PRODUCTION SECURITY CHECK !!!
        // 1. Check if bank says SUCCESS
        // 2. Check if received amount >= expected amount
        if (bankData.STATUS === "TXN_SUCCESS") {
            if (parseFloat(bankData.TXNAMOUNT) >= parseFloat(data.amount_expected)) {
                
                // A. Update DB
                data.status = "SUCCESS";
                await redis.set(`order:${order_id}`, JSON.stringify(data), { ex: 600 }); // Keep for 10 mins

                // B. Call Seller Webhook
                if (data.callback_url) {
                    console.log(`Firing Webhook to: ${data.callback_url}`);
                    axios.post(data.callback_url, {
                        order_id: order_id,
                        status: "SUCCESS",
                        amount_paid: bankData.TXNAMOUNT
                    }).catch(e => console.error("Webhook failed", e.message));
                }

                return res.json({ status: "SUCCESS", redirect_to: data.return_url });
            } else {
                // Fraud: Paid less
                data.status = "FRAUD";
                await redis.set(`order:${order_id}`, JSON.stringify(data), { ex: 600 });
                return res.json({ status: "FRAUD" });
            }
        } 
        
        return res.json({ status: "PENDING" });

    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Bank Error" });
    }
});


// ================================================================
// PART B: THE SELLER BACKEND (Simulating a Client)
// ================================================================

// 1. Seller initiates purchase
app.post('/seller/buy-item', async (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    // Seller calls YOUR Gateway API
    try {
        const gatewayRes = await axios.post(`${baseUrl}/api/create-order`, {
            amount: 2.00, // Testing with 1 Rupee
            seller_callback_url: `${baseUrl}/seller/webhook`, // Tell gateway where to report success
            seller_return_url: `${baseUrl}/shop.html?status=paid` // Tell gateway where to send user
        });

        res.json(gatewayRes.data);
    } catch (e) {
        res.status(500).json({ error: "Gateway connection failed" });
    }
});

// 2. Seller receives confirmation (Webhook)
app.post('/seller/webhook', (req, res) => {
    console.log("-----------------------------------------");
    console.log("✅ SELLER RECEIVED WEBHOOK FROM GATEWAY:");
    console.log(req.body);
    console.log("-----------------------------------------");
    // Here seller would update their database (e.g., deliver product)
    res.sendStatus(200);
});

// START SERVER
app.listen(PORT, () => console.log(`Gateway running on port ${PORT}`));
