const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// ==========================================
// 1. ULTIMATE CORS & PREFLIGHT FIX (সবার উপরে থাকবে)
// ==========================================
const allowedOrigins = [
    'https://assainment10-client.vercel.app',
    'http://localhost:3000'
];

app.use(cors({
    origin: function (origin, callback) {
        // যদি অরিজিন না থাকে (যেমন মোবাইল অ্যাপ বা পোস্টম্যান) অথবা অ্যালাউড লিস্টে থাকে
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(null, true); // সব অরিজিনকে আপাতত অ্যালাউ করছি সমস্যা সমাধানের জন্য
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// বিশেষ মিডলওয়্যার যা সব রিকোয়েস্টে ম্যানুয়ালি হেডার ইনজেক্ট করবে
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // ব্রাউজারের OPTIONS রিকোয়েস্টকে সরাসরি সাকসেস পাঠানো
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
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
        const reviewsCollection = db.collection("reviews");
        const bookmarksCollection = db.collection("bookmarks");
        const paymentsCollection = db.collection("payments");
        const reportsCollection = db.collection("reports");

        // ==========================================
        // 2. JWT & Verify Middlewares
        // ==========================================
        app.post('/jwt', async (req, res) => {
            const token = jwt.sign(req.body, process.env.JWT_SECRET, { expiresIn: '1h' });
            res.send({ token });
        });

        const verifyToken = (req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader) return res.status(401).send({ message: 'No auth header' });
            const token = authHeader.split(' ')[1];
            jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
                if (err) return res.status(401).send({ message: 'Invalid token' });
                req.decoded = decoded;
                next();
            });
        };

        const verifyAdmin = async (req, res, next) => {
            const user = await usersCollection.findOne({ email: req.decoded.email });
            if (user?.role !== 'Admin') return res.status(403).send({ message: 'Forbidden' });
            next();
        };

        // ==========================================
        // 3. User & Admin Roles
        // ==========================================
        app.post('/users', async (req, res) => {
            const existing = await usersCollection.findOne({ email: req.body.email });
            if (existing) return res.send({ message: 'Exists' });
            res.send(await usersCollection.insertOne({ ...req.body, role: 'User', status: 'Free', createdAt: new Date() }));
        });

        app.get('/users/login-check/:email', async (req, res) => {
            res.send(await usersCollection.findOne({ email: req.params.email }));
        });

        app.get('/admin/all-users', verifyToken, verifyAdmin, async (req, res) => {
            const result = await usersCollection.find().toArray();
            res.send(result);
        });

        app.patch('/admin/users/role/:id', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await usersCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { role: req.body.role } }));
        });

        app.get('/user-stats/:email', verifyToken, async (req, res) => {
            const count = await promptsCollection.countDocuments({ creatorEmail: req.params.email });
            const user = await usersCollection.findOne({ email: req.params.email });
            res.send({ promptCount: count, status: user?.status, role: user?.role });
        });

        // ==========================================
        // 4. Prompt Management (Fixed CRUD)
        // ==========================================
        app.post('/add-prompt', verifyToken, async (req, res) => {
            const user = await usersCollection.findOne({ email: req.decoded.email });
            const count = await promptsCollection.countDocuments({ creatorEmail: req.decoded.email });
            if (user.status === 'Free' && count >= 3) return res.status(403).send({ message: 'limit-reached' });
            res.send(await promptsCollection.insertOne({ ...req.body, creatorEmail: req.decoded.email, status: 'pending', copyCount: 0, rating: 0, createdAt: new Date() }));
        });

        app.get('/my-prompts/:email', verifyToken, async (req, res) => {
            res.send(await promptsCollection.find({ creatorEmail: req.params.email }).toArray());
        });

        app.patch('/prompts/:id', verifyToken, async (req, res) => {
            res.send(await promptsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: req.body }));
        });

        app.delete('/prompts/:id', verifyToken, async (req, res) => {
            res.send(await promptsCollection.deleteOne({ _id: new ObjectId(req.params.id) }));
        });

        // ==========================================
        // 5. Interactions & Feedback
        // ==========================================
        app.post('/reviews', verifyToken, async (req, res) => {
            res.send(await reviewsCollection.insertOne({ ...req.body, date: new Date() }));
        });

        app.get('/reviews/prompt/:id', async (req, res) => {
            res.send(await reviewsCollection.find({ promptId: req.params.id }).toArray());
        });

        app.post('/bookmarks', verifyToken, async (req, res) => {
            const { userEmail, promptId } = req.body;
            const exists = await bookmarksCollection.findOne({ userEmail, promptId });
            if (exists) {
                await bookmarksCollection.deleteOne({ userEmail, promptId });
                return res.send({ message: "removed" });
            } else {
                await bookmarksCollection.insertOne({ ...req.body, date: new Date() });
                return res.send({ message: "saved" });
            }
        });

        app.get('/bookmarks/:email', verifyToken, async (req, res) => {
            res.send(await bookmarksCollection.find({ userEmail: req.params.email }).toArray());
        });

        app.post('/reports', verifyToken, async (req, res) => {
            res.send(await reportsCollection.insertOne({ ...req.body, date: new Date() }));
        });

        // ==========================================
        // 6. Marketplace
        // ==========================================
        app.get('/featured-prompts', async (req, res) => {
            res.send(await promptsCollection.find({ status: 'approved' }).limit(6).sort({ createdAt: -1 }).toArray());
        });

        app.get('/prompts', async (req, res) => {
            const { search, category, aiTool, sort } = req.query;
            let query = { status: 'approved' };
            if (search) query.title = { $regex: search, $options: 'i' };
            if (category) query.category = category;
            const result = await promptsCollection.find(query).toArray();
            res.send({ result });
        });

        app.get('/prompts/:id', async (req, res) => {
            res.send(await promptsCollection.findOne({ _id: new ObjectId(req.params.id) }));
        });

        // ==========================================
        // 7. Payment APIs (Fixed Simulation & Admin)
        // ==========================================
        app.post('/simulate-payment', verifyToken, async (req, res) => {
            const email = req.decoded.email;
            const user = await usersCollection.findOne({ email });
            const mockPayment = { email, userName: user?.name, amount: 5, transactionId: `SIM_${Date.now()}`, date: new Date(), method: 'Sandbox' };
            await paymentsCollection.insertOne(mockPayment);
            await usersCollection.updateOne({ email: email }, { $set: { status: 'Premium' } });
            res.send({ success: true });
        });

        app.post('/create-payment-intent', verifyToken, async (req, res) => {
            const paymentIntent = await stripe.paymentIntents.create({ amount: 500, currency: 'usd', payment_method_types: ['card'] });
            res.send({ clientSecret: paymentIntent.client_secret });
        });

        app.get('/admin/all-payments', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await paymentsCollection.find().sort({ date: -1 }).toArray());
        });

        // ==========================================
        // 8. Admin Analytics (Aggregation)
        // ==========================================
        app.get('/admin-stats', verifyToken, verifyAdmin, async (req, res) => {
            const stats = await promptsCollection.aggregate([{ $group: { _id: null, totalPrompts: { $sum: 1 }, totalCopies: { $sum: "$copyCount" }, avgRating: { $avg: "$rating" } } }]).toArray();
            const totalUsers = await usersCollection.countDocuments();
            const totalRevenue = await paymentsCollection.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]).toArray();
            res.send({ stats: stats[0] || {}, totalUsers, totalRevenue: totalRevenue[0]?.total || 0 });
        });

        console.log("Master Backend Synchronized ✅");
    } finally { }
}
run().catch(console.dir);
app.get('/', (req, res) => res.send('Neural Mainframe Active'));
app.listen(port, () => console.log(`Listening on ${port}`));