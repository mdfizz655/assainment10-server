const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// ==========================================
// 1. CORS Configuration (লাইভ লিঙ্কের জন্য সঠিক কনফিগারেশন)
// ==========================================
app.use(cors({
    origin: [
        'https://assainment10-client.vercel.app', 
        'http://localhost:3000'
    ],
    credentials: true
}));
app.options('*', cors());
app.use(express.json());

// --- MongoDB Connection ---
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ay91vcf.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
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
        // 2. JWT & Middlewares
        // ==========================================
        app.post('/jwt', async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '1h' });
            res.send({ token });
        });

        const verifyToken = (req, res, next) => {
            if (!req.headers.authorization) {
                return res.status(401).send({ message: 'Unauthorized access' });
            }
            const token = req.headers.authorization.split(' ')[1];
            jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
                if (err) {
                    return res.status(401).send({ message: 'Unauthorized access' });
                }
                req.decoded = decoded;
                next();
            });
        };

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const user = await usersCollection.findOne({ email });
            if (user?.role !== 'Admin') return res.status(403).send({ message: 'Forbidden access' });
            next();
        };

        // ==========================================
        // 3. User & Auth APIs
        // ==========================================
        app.post('/users', async (req, res) => {
            const user = req.body;
            const existing = await usersCollection.findOne({ email: user.email });
            if (existing) return res.send({ message: 'Exists', insertedId: null });
            const result = await usersCollection.insertOne({ ...user, role: 'User', status: 'Free', createdAt: new Date() });
            res.send(result);
        });

        app.get('/users/login-check/:email', async (req, res) => {
            res.send(await usersCollection.findOne({ email: req.params.email }));
        });

        app.get('/users/me/:email', verifyToken, async (req, res) => {
            res.send(await usersCollection.findOne({ email: req.params.email }));
        });

        app.patch('/admin/users/role/:id', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await usersCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { role: req.body.role } }));
        });

        app.get('/admin/all-users', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await usersCollection.find().toArray());
        });

        // প্রোফাইল পেজের ডাইনামিক স্ট্যাটস
        app.get('/user-stats/:email', verifyToken, async (req, res) => {
            const count = await promptsCollection.countDocuments({ creatorEmail: req.params.email });
            const user = await usersCollection.findOne({ email: req.params.email });
            res.send({ promptCount: count, status: user?.status, role: user?.role });
        });

        // ==========================================
        // 4. Prompt Management (Fixed Add Prompt)
        // ==========================================
        app.post('/add-prompt', verifyToken, async (req, res) => {
            const email = req.decoded.email;
            const user = await usersCollection.findOne({ email: email });
            const count = await promptsCollection.countDocuments({ creatorEmail: email });

            if (user.status === 'Free' && count >= 3) {
                return res.status(403).send({ message: 'limit-reached' });
            }

            // রিকোয়েস্ট বডির সাথে টোকেন থেকে ইমেইলটি জোরপূর্বক যোগ করা হয়েছে
            const newPrompt = { 
                ...req.body, 
                creatorEmail: email, 
                status: 'pending', 
                copyCount: 0, 
                rating: 0, 
                createdAt: new Date() 
            };
            const result = await promptsCollection.insertOne(newPrompt);
            res.send(result);
        });

        app.patch('/prompts/:id', verifyToken, async (req, res) => {
            res.send(await promptsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: req.body }));
        });

        app.delete('/prompts/:id', verifyToken, async (req, res) => {
            res.send(await promptsCollection.deleteOne({ _id: new ObjectId(req.params.id) }));
        });

        app.get('/my-prompts/:email', verifyToken, async (req, res) => {
            res.send(await promptsCollection.find({ creatorEmail: req.params.email }).toArray());
        });

        app.patch('/prompts/copy-count/:id', async (req, res) => {
            res.send(await promptsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $inc: { copyCount: 1 } }));
        });

        // ==========================================
        // 5. Admin Moderation & Reports
        // ==========================================
        app.get('/admin/all-prompts', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await promptsCollection.find().toArray());
        });

        app.patch('/admin/prompt-status/:id', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await promptsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: req.body.status, feedback: req.body.feedback || "" } }));
        });

        app.get('/admin/reports', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await reportsCollection.find().toArray());
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
            const query = { userEmail: req.body.userEmail, promptId: req.body.promptId };
            const exists = await bookmarksCollection.findOne(query);
            if (exists) {
                await bookmarksCollection.deleteOne(query);
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
        // 7. Marketplace & Featured
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
            let sortObj = { createdAt: -1 };
            if (sort === 'popular') sortObj = { rating: -1 };

            const result = await promptsCollection.find(query).sort(sortObj).toArray();
            res.send({ result });
        });

        app.get('/prompts/:id', async (req, res) => {
            res.send(await promptsCollection.findOne({ _id: new ObjectId(req.params.id) }));
        });

        // ==========================================
        // 8. Admin Stats
        // ==========================================
        app.get('/admin-stats', verifyToken, verifyAdmin, async (req, res) => {
            const stats = await promptsCollection.aggregate([{ $group: { _id: null, totalPrompts: { $sum: 1 }, totalCopies: { $sum: "$copyCount" }, avgRating: { $avg: "$rating" } } }]).toArray();
            const totalUsers = await usersCollection.countDocuments();
            const totalRevenue = await paymentsCollection.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]).toArray();
            res.send({ stats: stats[0] || {}, totalUsers, totalRevenue: totalRevenue[0]?.total || 0 });
        });

        // ==========================================
        // 9. Payment APIs (Fixed Simulation)
        // ==========================================
   3. Simulated Payment (Success -> Account Premium)
        app.post('/simulate-payment', verifyToken, async (req, res) => {
            const email = req.decoded.email;
            const mockPayment = { email, amount: 5, transactionId: `sim_${Date.now()}`, date: new Date() };
            
            await paymentsCollection.insertOne(mockPayment);
            // ইউজারের স্ট্যাটাস Premium করা (অ্যাসাইনমেন্টের মেইন শর্ত)
            const result = await usersCollection.updateOne({ email: email }, { $set: { status: 'Premium' } });
            res.send({ success: true, result });
        });


        app.post('/create-payment-intent', verifyToken, async (req, res) => {
            const paymentIntent = await stripe.paymentIntents.create({
                amount: 500,
                currency: 'usd',
                payment_method_types: ['card']
            });
            res.send({ clientSecret: paymentIntent.client_secret });
        });

        app.post('/payments', verifyToken, async (req, res) => {
            await paymentsCollection.insertOne(req.body);
            await usersCollection.updateOne({ email: req.body.email }, { $set: { status: 'Premium' } });
            res.send({ success: true });
        });

        console.log("Database Synced & All Systems Operational ✅");
    } finally { }
}
run().catch(console.dir);
app.get('/', (req, res) => res.send('Neural Server is Live'));
app.listen(port, () => console.log(`Neural Port ${port}`));