require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { connectDB } = require("./config/db");
const authRoutes = require("./routes/auth");
const foodsRoutes = require("./routes/foods");
const ordersRoutes = require("./routes/orders");
const paymentsRoutes = require("./routes/payments");
const ridersRoutes = require("./routes/riders");
const statsRoutes = require("./routes/stats");
const reviewsRoutes = require("./routes/reviews");
const usersRoutes = require("./routes/users");
const notificationsRoutes = require("./routes/notifications");

const app = express();
const port = 3000;

app.use(
  cors({
    origin: ["https://sams-kitchen.netlify.app", "http://localhost:5173"],
    credentials: true,
  })
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
    } = await connectDB();

    app.use("/auth", authRoutes(usersCollection));
    app.use("/foods", foodsRoutes(foodsCollection, notificationsCollection));
    app.use("/orders", ordersRoutes(ordersCollection, ridersCollection, notificationsCollection));
    app.use("/payments", paymentsRoutes(ordersCollection, paymentsCollection, notificationsCollection));
    app.use("/riders", ridersRoutes(ridersCollection, usersCollection, ordersCollection, notificationsCollection));
    app.use("/stats", statsRoutes(usersCollection, ordersCollection, ridersCollection, foodsCollection));
    app.use("/reviews", reviewsRoutes(reviewsCollection, foodsCollection, notificationsCollection));
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