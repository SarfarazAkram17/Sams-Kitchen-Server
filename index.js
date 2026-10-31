import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { connectDB } from "./config/db.js";
import authRoutes from "./routes/auth.js";
import foodsRoutes from "./routes/foods.js";
import ordersRoutes from "./routes/orders.js";
import paymentsRoutes from "./routes/payments.js";
import ridersRoutes from "./routes/riders.js";
import statsRoutes from "./routes/stats.js";
import reviewsRoutes from "./routes/reviews.js";
import usersRoutes from "./routes/users.js";
import cashoutsRoutes from "./routes/cashouts.js";
import notificationsRoutes from "./routes/notifications.js";
import dns from "dns";
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(
  cors({
    origin: [process.env.CLIENT_ORIGIN, "http://localhost:5173"],
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send("Sam's Kitchen is cooking");
});

async function startServer() {
  try {
    const {
      usersCollection,
      foodsCollection,
      ordersCollection,
      paymentsCollection,
      ridersCollection,
      reviewsCollection,
      notificationsCollection,
      cashoutsCollection,
      deliveryOtpChallengesCollection,
    } = await connectDB();

    app.use("/auth", authRoutes(usersCollection));
    app.use("/foods", foodsRoutes(foodsCollection, notificationsCollection));
    app.use(
      "/orders",
      ordersRoutes(
        ordersCollection,
        ridersCollection,
        notificationsCollection,
        deliveryOtpChallengesCollection,
      ),
    );
    app.use(
      "/payments",
      paymentsRoutes(
        ordersCollection,
        paymentsCollection,
        notificationsCollection,
      ),
    );
    app.use(
      "/riders",
      ridersRoutes(
        ridersCollection,
        usersCollection,
        ordersCollection,
        notificationsCollection,
      ),
    );
    app.use(
      "/stats",
      statsRoutes(
        usersCollection,
        ordersCollection,
        ridersCollection,
        foodsCollection,
      ),
    );
    app.use(
      "/reviews",
      reviewsRoutes(
        reviewsCollection,
        foodsCollection,
        notificationsCollection,
      ),
    );
    app.use(
      "/cashouts",
      cashoutsRoutes(
        cashoutsCollection,
        ordersCollection,
        notificationsCollection,
      ),
    );
    app.use("/users", usersRoutes(usersCollection));
    app.use("/notifications", notificationsRoutes(notificationsCollection));

    app.listen(port, () => {
      console.log(`Sam's Kitchen running on port ${port}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
