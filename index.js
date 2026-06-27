const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// ==========================================
// 1. CORS Configuration (লাইভ সাইটের জন্য পারমিশন)
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
        // 2. JWT & Security Middlewares
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
                if (err) return res.status(401).send({ message: 'Unauthorized access' });
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
            if (existing) return res.send({ message: 'User exists', insertedId: null });
            const result = await usersCollection.insertOne({ 
                ...user, 
                role: 'User', 
                status: 'Free', 
                createdAt: new Date() 
            });
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
        // 4. Prompt Management (CRUD & Limits)
        // ==========================================
        
        // প্রম্পট অ্যাড করা (৩টি লিমিট লজিকসহ)
        app.post('/add-prompt', verifyToken, async (req, res) => {
            const email = req.decoded.email;
            const user = await usersCollection.findOne({ email });
            const count = await promptsCollection.countDocuments({ creatorEmail: email });

            // ফ্রি ইউজার ৩টির বেশি প্রম্পট দিতে পারবে না
            if (user.status === 'Free' && count >= 3) {
                return res.status(403).send({ message: 'Limit reached! Upgrade to Pro.' });
            }

            const newPrompt = { 
                ...req.body, 
                creatorEmail: email, 
                status: 'pending', 
                copyCount: 0, 
                rating: 0, 
                createdAt: new Date() 
            };
            res.send(await promptsCollection.insertOne(newPrompt));
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
        // 5. Interaction APIs (Reviews, Bookmarks, Reports)
        // ==========================================
        app.post('/reviews', verifyToken, async (req, res) => {
            res.send(await reviewsCollection.insertOne({ ...req.body, date: new Date() }));
        });

        app.get('/reviews/prompt/:id', async (req, res) => {
            res.send(await reviewsCollection.find({ promptId: req.params.id }).toArray());
        });

        app.get('/my-reviews/:email', verifyToken, async (req, res) => {
            res.send(await reviewsCollection.find({ reviewerEmail: req.params.email }).toArray());
        });

        app.post('/bookmarks', verifyToken, async (req, res) => {
            const { userEmail, promptId } = req.body;
            const query = { userEmail, promptId };
            const existing = await bookmarksCollection.findOne(query);
            if (existing) {
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
        // 6. Marketplace & Analytics
        // ==========================================
        app.get('/featured-prompts', async (req, res) => {
            res.send(await promptsCollection.find({ status: 'approved' }).limit(6).sort({ createdAt: -1 }).toArray());
        });

        app.get('/prompts', async (req, res) => {
            const { search, category, aiTool, sort, page = 1, limit = 6 } = req.query;
            const skip = (parseInt(page) - 1) * parseInt(limit);
            let query = { status: 'approved' };
            if (search) query.title = { $regex: search, $options: 'i' };
            if (category) query.category = category;
            if (aiTool) query.aiTool = aiTool;
            let sortObj = { createdAt: -1 };
            if (sort === 'popular') sortObj = { rating: -1 };
            if (sort === 'copies') sortObj = { copyCount: -1 };

            const result = await promptsCollection.find(query).sort(sortObj).skip(skip).limit(parseInt(limit)).toArray();
            const total = await promptsCollection.countDocuments(query);
            res.send({ result, total });
        });

        app.get('/prompts/:id', async (req, res) => {
            res.send(await promptsCollection.findOne({ _id: new ObjectId(req.params.id) }));
        });

        // এডমিন স্ট্যাটস (Aggregation ব্যবহার করে)
        app.get('/admin-stats', verifyToken, verifyAdmin, async (req, res) => {
            const stats = await promptsCollection.aggregate([{ $group: { _id: null, totalPrompts: { $sum: 1 }, totalCopies: { $sum: "$copyCount" }, avgRating: { $avg: "$rating" } } }]).toArray();
            const totalUsers = await usersCollection.countDocuments();
            const totalRevenue = await paymentsCollection.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]).toArray();
            res.send({ stats: stats[0] || {}, totalUsers, totalRevenue: totalRevenue[0]?.total || 0 });
        });

        // ==========================================
        // 7. Payment APIs (Stripe & Simulation)
        // ==========================================
        
        // সিমুলেটেড পেমেন্ট এপিআই (Fixed)
        app.post('/simulate-payment', verifyToken, async (req, res) => {
            const email = req.decoded.email;
            const mockPayment = { email, amount: 5.00, transactionId: `SIM_${Date.now()}`, date: new Date(), method: 'Sandbox' };
            await paymentsCollection.insertOne(mockPayment);
            await usersCollection.updateOne({ email: email }, { $set: { status: 'Premium' } });
            res.send({ success: true });
        });

        app.post('/create-payment-intent', verifyToken, async (req, res) => {
            const paymentIntent = await stripe.paymentIntents.create({ amount: 500, currency: 'usd', payment_method_types: ['card'] });
            res.send({ clientSecret: paymentIntent.client_secret });
        });

        app.post('/payments', verifyToken, async (req, res) => {
            await paymentsCollection.insertOne(req.body);
            await usersCollection.updateOne({ email: req.body.email }, { $set: { status: 'Premium' } });
            res.send({ insertedId: true });
        });

        // অ্যাডমিনদের সব প্রম্পট দেখা
        app.get('/admin/all-prompts', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await promptsCollection.find().toArray());
        });

        // প্রম্পট স্ট্যাটাস আপডেট
        app.patch('/admin/prompt-status/:id', verifyToken, verifyAdmin, async (req, res) => {
            res.send(await promptsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: req.body.status, feedback: req.body.feedback || "" } }));
        });

        console.log("PROMPTLY Backend is 100% Ready! ✅");
    } finally { }
}
run().catch(console.dir);
app.get('/', (req, res) => res.send('API Active'));
app.listen(port, () => console.log(`Listening on ${port}`));