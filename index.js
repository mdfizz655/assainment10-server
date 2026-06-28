const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// ==========================================
// 1. ULTIMATE CORS & PREFLIGHT FIX (Nuclear Option)
// ==========================================
app.use(cors({
    origin: true, // যেকোনো অরিজিন এলাউ করবে যাতে Vercel/Localhost এ সমস্যা না হয়
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']
}));

// বিশেষ মিডলওয়্যার: এটি ম্যানুয়ালি ব্রাউজারের প্রি-ফ্লাইট চেক পাস করে দিবে
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.header('Origin'));
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    
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
        // 2. JWT & Security Middlewares
        // ==========================================
        app.post('/jwt', async (req, res) => {
            const token = jwt.sign(req.body, process.env.JWT_SECRET, { expiresIn: '1h' });
            res.send({ token });
        });

        const verifyToken = (req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).send({ message: 'No valid token provided' });
            }
            const token = authHeader.split(' ')[1];
            jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
                if (err) return res.status(401).send({ message: 'Invalid or expired token' });
                req.decoded = decoded;
                next();
            });
        };

        const verifyAdmin = async (req, res, next) => {
            const user = await usersCollection.findOne({ email: req.decoded.email });
            if (user?.role !== 'Admin') return res.status(403).send({ message: 'Forbidden access' });
            next();
        };

        // ==========================================
        // 3. User & Dynamic Statistics APIs
        // ==========================================
        app.post('/users', async (req, res) => {
            const existing = await usersCollection.findOne({ email: req.body.email });
            if (existing) return res.send({ message: 'User exists', insertedId: null });
            res.send(await usersCollection.insertOne({ ...req.body, role: 'User', status: 'Free', createdAt: new Date() }));
        });

        app.get('/users/login-check/:email', async (req, res) => {
            res.send(await usersCollection.findOne({ email: req.params.email }));
        });

        app.get('/user-stats/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            const count = await promptsCollection.countDocuments({ creatorEmail: email });
            const user = await usersCollection.findOne({ email });
            res.send({ promptCount: count, status: user?.status, role: user?.role });
        });

        // ==========================================
        // 4. Prompt Management (CRUD & 3-Limit Logic)
        // ==========================================
        app.post('/add-prompt', verifyToken, async (req, res) => {
            const email = req.decoded.email;
            const user = await usersCollection.findOne({ email });
            const count = await promptsCollection.countDocuments({ creatorEmail: email });

            if (user.status === 'Free' && count >= 3) {
                return res.status(403).send({ message: 'Limit reached' });
            }
            const newPrompt = { ...req.body, creatorEmail: email, status: 'pending', copyCount: 0, rating: 0, createdAt: new Date() };
            res.send(await promptsCollection.insertOne(newPrompt));
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

        app.patch('/prompts/copy-count/:id', async (req, res) => {
            res.send(await promptsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $inc: { copyCount: 1 } }));
        });

        // ==========================================
        // 5. Admin Moderation & Aggregation Stats
        // ==========================================
        app.get('/admin/all-prompts', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await promptsCollection.find().toArray());
        });

        app.patch('/admin/prompt-status/:id', verifyToken, verifyAdmin, async (req, res) => {
            const { status, feedback } = req.body;
            res.send(await promptsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status, feedback: feedback || "" } }));
        });

        app.get('/admin-stats', verifyToken, verifyAdmin, async (req, res) => {
            const stats = await promptsCollection.aggregate([{ $group: { _id: null, totalPrompts: { $sum: 1 }, totalCopies: { $sum: "$copyCount" }, avgRating: { $avg: "$rating" } } }]).toArray();
            const totalUsers = await usersCollection.countDocuments();
            const totalRevenue = await paymentsCollection.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]).toArray();
            res.send({ stats: stats[0] || {}, totalUsers, totalRevenue: totalRevenue[0]?.total || 0 });
        });

        app.get('/admin/all-users', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await usersCollection.find().toArray());
        });

        app.get('/admin/all-payments', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await paymentsCollection.find().sort({ date: -1 }).toArray());
        });

        // ==========================================
        // 6. Interaction APIs (Reviews, Bookmarks, Reports)
        // ==========================================
        app.post('/reviews', verifyToken, async (req, res) => {
            res.send(await reviewsCollection.insertOne({ ...req.body, date: new Date() }));
        });

        app.get('/reviews/prompt/:id', async (req, res) => {
            res.send(await reviewsCollection.find({ promptId: req.params.id }).toArray());
        });

        app.post('/bookmarks', verifyToken, async (req, res) => {
            const { userEmail, promptId } = req.body;
            const existing = await bookmarksCollection.findOne({ userEmail, promptId });
            if (existing) {
                await bookmarksCollection.deleteOne({ userEmail, promptId });
                return res.send({ message: "removed" });
            }
            res.send({ ...await bookmarksCollection.insertOne({ ...req.body, date: new Date() }), message: "saved" });
        });

        app.get('/bookmarks/:email', verifyToken, async (req, res) => {
            res.send(await bookmarksCollection.find({ userEmail: req.params.email }).toArray());
        });

        app.post('/reports', verifyToken, async (req, res) => {
            res.send(await reportsCollection.insertOne({ ...req.body, date: new Date() }));
        });

        app.get('/admin/reports', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await reportsCollection.find().toArray());
        });

        // ==========================================
        // 7. Payment APIs (Real & Fixed Simulation)
        // ==========================================
        app.post('/simulate-payment', verifyToken, async (req, res) => {
            const email = req.decoded.email;
            const user = await usersCollection.findOne({ email });
            const mockPayment = { 
                email, userName: user?.name, amount: 5, transactionId: `SIM_${Date.now()}`, date: new Date(), method: 'Sandbox' 
            };
            await paymentsCollection.insertOne(mockPayment);
            await usersCollection.updateOne({ email: email }, { $set: { status: 'Premium' } });
            res.send({ success: true });
        });

        app.post('/create-payment-intent', verifyToken, async (req, res) => {
            const paymentIntent = await stripe.paymentIntents.create({ amount: 500, currency: 'usd', payment_method_types: ['card'] });
            res.send({ clientSecret: paymentIntent.client_secret });
        });

        app.post('/payments', verifyToken, async (req, res) => {
            const payment = req.body;
            await paymentsCollection.insertOne(payment);
            await usersCollection.updateOne({ email: payment.email }, { $set: { status: 'Premium' } });
            res.send({ success: true });
        });

        // ==========================================
        // 8. Creator Stats & Analytics
        // ==========================================
        app.get('/creator-stats/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            const stats = await promptsCollection.aggregate([
                { $match: { creatorEmail: email } },
                { $group: { _id: null, totalPrompts: { $sum: 1 }, totalCopies: { $sum: "$copyCount" } } }
            ]).toArray();
            const chartData = await promptsCollection.find({ creatorEmail: email }).project({ title: 1, copyCount: 1 }).toArray();
            res.send({ stats: stats[0] || { totalPrompts: 0, totalCopies: 0 }, chartData });
        });

        // ==========================================
        // 9. Marketplace & Home Page
        // ==========================================
        app.get('/featured-prompts', async (req, res) => {
            res.send(await promptsCollection.find({ status: 'approved' }).limit(6).sort({ createdAt: -1 }).toArray());
        });

        app.get('/prompts', async (req, res) => {
            const { search, category, aiTool, sort } = req.query;
            let query = { status: 'approved' };
            if (search) query.title = { $regex: search, $options: 'i' };
            if (category) query.category = category;
            if (aiTool) query.aiTool = aiTool;
            const result = await promptsCollection.find(query).toArray();
            res.send({ result });
        });

        console.log("Database Operational: Master Mainframe Ready ✅");
    } finally { }
}
run().catch(console.dir);
app.get('/', (req, res) => res.send('API Online'));
app.listen(port, () => console.log(`Listening on ${port}`));