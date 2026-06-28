const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// ==========================================
// ১. সুপার শক্তিশালী CORS ফিক্স (সবার আগে)
// ==========================================
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.header('Origin') || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.header('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());

// --- MongoDB Connection ---
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ay91vcf.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

async function run() {
    try {
        const db = client.db("promptlyDB");
        const usersCollection = db.collection("users");
        const promptsCollection = db.collection("prompts");
        const paymentsCollection = db.collection("payments");

        // ২. টোকেন চেক করার ফাংশন (৪MD ৪০১ ফিক্স)
        const verifyToken = (req, res, next) => {
            if (!req.headers.authorization) return res.status(401).send({ message: 'No Token' });
            const token = req.headers.authorization.split(' ')[1];
            jwt.verify(token, process.env.JWT_SECRET || 'secret_fallback', (err, decoded) => {
                if (err) return res.status(401).send({ message: 'Invalid Token' });
                req.decoded = decoded;
                next();
            });
        };

        // ৩. টোকেন তৈরি
        app.post('/jwt', async (req, res) => {
            const token = jwt.sign(req.body, process.env.JWT_SECRET || 'secret_fallback', { expiresIn: '1h' });
            res.send({ token });
        });

        // ৪. প্রম্পট অ্যাড (৩টি লিমিটসহ)
        app.post('/add-prompt', verifyToken, async (req, res) => {
            const email = req.decoded.email;
            const user = await usersCollection.findOne({ email });
            const count = await promptsCollection.countDocuments({ creatorEmail: email });
            if (user?.status === 'Free' && count >= 3) return res.status(403).send({ message: 'limit-reached' });
            res.send(await promptsCollection.insertOne({ ...req.body, creatorEmail: email, status: 'pending', createdAt: new Date() }));
        });

        // ৫. সিমুলেটেড পেমেন্ট (১০০% ডাইনামিক)
        app.post('/simulate-payment', verifyToken, async (req, res) => {
            const email = req.decoded.email;
            await paymentsCollection.insertOne({ email, amount: 5, transactionId: `SIM_${Date.now()}`, date: new Date() });
            await usersCollection.updateOne({ email }, { $set: { status: 'Premium' } });
            res.send({ success: true });
        });

        // --- অন্যান্য দরকারি এপিআই ---
        app.post('/users', async (req, res) => {
            const existing = await usersCollection.findOne({ email: req.body.email });
            if (existing) return res.send({ message: 'exists' });
            res.send(await usersCollection.insertOne({ ...req.body, role: 'User', status: 'Free', createdAt: new Date() }));
        });

        app.get('/users/login-check/:email', async (req, res) => {
            res.send(await usersCollection.findOne({ email: req.params.email }));
        });

        app.get('/my-prompts/:email', verifyToken, async (req, res) => {
            res.send(await promptsCollection.find({ creatorEmail: req.params.email }).toArray());
        });

        console.log("Database Connected ✅");
    } finally { }
}
run().catch(console.dir);
app.get('/', (req, res) => res.send('API LIVE'));
app.listen(port, () => console.log(`Neural Port ${port}`));