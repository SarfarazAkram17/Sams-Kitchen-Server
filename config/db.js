import { MongoClient, ServerApiVersion } from "mongodb";
import "dotenv/config";

const DB_NAME = "Sams-Kitchen";

// Role definitions live in the database. These defaults are inserted once on
// first start; after that an admin can edit them in MongoDB and the change
// shows up everywhere (onboarding, labels, filters) without a deploy.
const DEFAULT_ROLES = [
  {
    key: "customer",
    label: "Customer",
    description: "Order fresh meals from Sam's Kitchen and track every delivery.",
    icon: "customer",
    selectable: true,
    requiresApproval: false,
    isDefault: true,
    order: 1,
  },
  {
    key: "rider",
    label: "Rider",
    description: "Deliver orders in your area and cash out what you earn.",
    icon: "rider",
    selectable: true,
    requiresApproval: true,
    isDefault: false,
    order: 2,
  },
  {
    key: "admin",
    label: "Admin",
    description: "Run the kitchen, the menu, riders and payouts.",
    icon: "admin",
    selectable: false,
    requiresApproval: false,
    isDefault: false,
    order: 3,
  },
];

async function seedRoles(rolesCollection) {
  await rolesCollection.createIndex({ key: 1 }, { unique: true });
  await rolesCollection.bulkWrite(
    DEFAULT_ROLES.map((role) => ({
      updateOne: {
        filter: { key: role.key },
        update: { $setOnInsert: role },
        upsert: true,
      },
    })),
  );
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.or0q8ig.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function connectDB() {
  try {
    await client.connect();

    const db = client.db(DB_NAME);
    console.log("Connected to MongoDB!");
    const deliveryOtpChallengesCollection = db.collection(
      "deliveryOtpChallenges",
    );
    await deliveryOtpChallengesCollection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0 },
    );

    const rolesCollection = db.collection("rolesCollection");
    await seedRoles(rolesCollection);

    return {
      rolesCollection,
      usersCollection: db.collection("usersCollection"),
      foodsCollection: db.collection("foodsCollection"),
      ordersCollection: db.collection("ordersCollection"),
      paymentsCollection: db.collection("paymentsCollection"),
      ridersCollection: db.collection("ridersCollection"),
      reviewsCollection: db.collection("reviewsCollection"),
      notificationsCollection: db.collection("notificationsCollection"),
      cashoutsCollection: db.collection("cashoutsCollection"),
      deliveryOtpChallengesCollection,
    };
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    throw error;
  }
}

export { connectDB, client, DB_NAME };