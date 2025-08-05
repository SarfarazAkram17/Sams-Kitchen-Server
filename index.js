require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const port = 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const cookieParser = require("cookie-parser");
const { default: axios } = require("axios");

app.use(
  cors({
    origin: ["https://sams-kitchen.netlify.app", "http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded());

app.get("/", (req, res) => {
  res.send("Sam's Kitchen is cooking");
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.or0q8ig.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  const verifyJwt = (req, res, next) => {
    const token = req.cookies.token;

    if (!token) {
      return res.status(401).send({ message: "Unauthorized Access" });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) {
        return res.status(403).send({ message: "Forbidden: Invalid token" });
      }

      if (req.query.email !== decoded.email) {
        return res.status(403).send({ message: "Forbidden: Email mismatch" });
      }
      req.user = decoded;

      next();
    });
  };

  const verifyAdmin = (req, res, next) => {
    if (req.user.role !== "admin") {
      return res.status(403).send({ message: "Forbidden: Admins only" });
    }
    next();
  };

  const verifyCustomer = (req, res, next) => {
    if (req.user.role !== "customer") {
      return res.status(403).send({ message: "Forbidden: Customer only" });
    }
    next();
  };

  const verifyRider = (req, res, next) => {
    if (req.user.role !== "rider") {
      return res.status(403).send({ message: "Forbidden: Riders only" });
    }
    next();
  };

  try {
    await client.connect();

    const db = client.db("Sams-Kitchen");
    const usersCollection = db.collection("usersCollection");
    const foodsCollection = db.collection("foodsCollection");
    const ordersCollection = db.collection("ordersCollection");
    const paymentsCollection = db.collection("paymentsCollection");
    const ridersCollection = db.collection("ridersCollection");

    // create ssl payment
    app.post("/create-ssl-payment", verifyJwt, async (req, res) => {
      const store_id = process.env.STORE_ID;
      const store_passwd = process.env.STORE_PASSWORD;

      const payment = req.body;
      const order = await ordersCollection.findOne({
        _id: new ObjectId(payment.orderId),
      });

      const tran_id = new ObjectId().toString();
      payment.transactionId = tran_id;

      const initiate = {
        store_id,
        store_passwd,
        total_amount: order.total,
        currency: "BDT",
        tran_id,
        success_url: "http://localhost:3000/success-payment",
        fail_url: "http://localhost:3000/fail-payment",
        cancel_url: "http://localhost:3000/cancel-payment",
        ipn_url: "http://localhost:3000/ipn-success-payment",
        shipping_method: "Courier",
        product_name: "Foods",
        product_category: "Food",
        product_profile: "general",
        cus_name: payment.name,
        cus_email: payment.email,
        cus_add1: order.customer.address.district,
        cus_city: order.customer.address.thana,
        cus_state: order.customer.address.region,
        cus_country: "Bangladesh",
        cus_phone: order.customer.phone,
        ship_name: payment.name,
        ship_add1: order.customer.address.district,
        ship_city: order.customer.address.thana,
        ship_state: order.customer.address.region,
        ship_postcode: 1000,
        ship_country: "Bangladesh",
      };

      const iniRes = await axios({
        url: "https://sandbox.sslcommerz.com/gwprocess/v4/api.php",
        method: "POST",
        data: initiate,
        headers: {
          "Content-type": "application/x-www-form-urlencoded",
        },
      });

      const gatewayUrl = iniRes?.data?.GatewayPageURL;

      await paymentsCollection.insertOne(payment);

      res.status(201).send({
        gatewayUrl,
      });
    });

    app.post("/success-payment", async (req, res) => {
      const paymentSuccess = req.body;
      const query = {
        transactionId: paymentSuccess.tran_id,
      };
      const payment = await paymentsCollection.findOne(query);

      const store_id = process.env.STORE_ID;
      const store_passwd = process.env.STORE_PASSWORD;

      const isValidPayment = await axios.get(
        `https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php?val_id=${paymentSuccess.val_id}&store_id=${store_id}&store_passwd=${store_passwd}`
      );

      if (isValidPayment?.data?.status === "VALID") {
        // update order payment status
        const updatedOrder = {
          $set: {
            payment_status: "paid",
            status: "not_assigned",
            paidAt: new Date().toISOString(),
          },
        };
        const updateOrder = await ordersCollection.updateOne(
          { _id: new ObjectId(payment.orderId) },
          updatedOrder
        );

        // update payments status
        const updatedPayment = {
          $set: {
            status: "payment done",
            paid_at: new Date().toISOString(),
          },
        };
        const updatePaymentStatus = await paymentsCollection.updateOne(
          query,
          updatedPayment
        );
        return res.redirect("http://localhost:5173/dashboard/myOrders");
      } else {
        const deletePayment = await paymentsCollection.deleteOne(query);
        res.redirect("http://localhost:5173/dashboard/myOrders");
        return res.send({ message: "Invalid payment" });
      }
    });

    app.post("/fail-payment", async (req, res) => {
      const failPayment = req.body;
      const query = { transactionId: failPayment.tran_id };

      await paymentsCollection.deleteOne(query);

      return res.redirect("http://localhost:5173/dashboard/myOrders");
    });

    app.post("/cancel-payment", async (req, res) => {
      const cancelPayment = req.body;
      const query = { transactionId: cancelPayment.tran_id };

      await paymentsCollection.deleteOne(query);

      return res.redirect("http://localhost:5173/dashboard/myOrders");
    });

    // creating payment intent for stripe
    app.post("/create-payment-intent", verifyJwt, async (req, res) => {
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: req.body.amountInCents,
          currency: "bdt",
          payment_method_types: ["card"],
        });
        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // JWT API
    app.post("/jwt", async (req, res) => {
      const { email } = req.body;
      const user = await usersCollection.findOne({ email });

      const payload = { email: user.email, role: user.role };
      const token = jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: "1d",
      });

      res.cookie("token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        maxAge: 24 * 60 * 60 * 1000,
      });

      res.send({ success: true, token });
    });

    // remove token when logout
    app.post("/logout", (req, res) => {
      res.clearCookie("token", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      });
      res.send({ success: true });
    });

    // users api
    app.get("/users", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        let {
          page = 1,
          limit = 10,
          search = "",
          searchType = "name",
          role = "",
        } = req.query;

        page = parseInt(page);
        limit = parseInt(limit);

        const query = {};

        if (search) {
          const regex = new RegExp(search, "i");
          if (searchType === "email") {
            query.email = regex;
          } else {
            query.name = regex;
          }
        }

        if (role) {
          query.role = role;
        }

        const skip = (page - 1) * limit;
        const total = await usersCollection.countDocuments(query);
        const users = await usersCollection
          .find(query)
          .skip(skip)
          .limit(limit)
          .toArray();

        res.send({ users, total });
      } catch (err) {
        res.status(500).send({ message: "Server error", error: err.message });
      }
    });

    app.get("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({ role: user.role });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      const email = user.email;

      const userExists = await usersCollection.findOne({ email });

      if (userExists) {
        const updateResult = await usersCollection.updateOne(
          { email },
          { $set: { last_log_in: user.last_log_in } }
        );
        return res.status(200).send({
          message: "User already exists, last_log_in updated",
          updated: updateResult.modifiedCount > 0,
        });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.patch("/users", verifyJwt, async (req, res) => {
      try {
        const { name, photo } = req.body;
        const { email } = req.query;

        if (!email) {
          return res
            .status(400)
            .send({ success: false, message: "Email is required." });
        }

        const filter = { email };
        const updateDoc = {
          $set: {
            name,
            photo,
          },
        };

        const result = await usersCollection.updateOne(filter, updateDoc);
        res.send(result);
      } catch (_) {
        res.status(500).send({
          success: false,
          message: "Internal server error while updating profile",
        });
      }
    });

    // foods api
    app.get("/foods", async (req, res) => {
      try {
        let { page = 1, limit = 10 } = req.query;

        page = parseInt(page);
        limit = parseInt(limit);

        const skip = (page - 1) * limit;

        const total = await foodsCollection.countDocuments();
        const foods = await foodsCollection
          .find({})
          .sort({ addedAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        res.send({ foods, total });
      } catch (err) {
        res
          .status(500)
          .send({ message: "Failed to fetch foods", error: err.message });
      }
    });

    app.get("/foods/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const food = await foodsCollection.findOne({ _id: new ObjectId(id) });

        if (!food) {
          return res.status(404).send({ message: "Food not found" });
        }

        res.send(food);
      } catch (err) {
        res
          .status(500)
          .send({ message: "Failed to fetch food", error: err.message });
      }
    });

    app.post("/foods", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const {
          name,
          price,
          discount = 0,
          description = "",
          image,
          available = true,
          addedAt,
        } = req.body;

        const newFood = {
          name: name.trim(),
          price,
          discount,
          description: description.trim(),
          image,
          available,
          addedAt,
        };

        const result = await foodsCollection.insertOne(newFood);

        res.status(201).json({
          message: "Food added successfully",
          foodId: result.insertedId,
        });
      } catch (_) {
        res.status(500).json({ error: "Internal server error" });
      }
    });

    // name post but its for get
    app.post("/foods/cart", async (req, res) => {
      try {
        const { ids } = req.body;

        const foodIds = ids.map((id) => new ObjectId(id));

        const foods = await foodsCollection
          .find({ _id: { $in: foodIds } })
          .toArray();

        res.send(foods);
      } catch (err) {
        res
          .status(500)
          .send({ message: "Failed to fetch foods", error: err.message });
      }
    });

    app.patch("/foods/:id", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const foodId = req.params.id;
        const { name, price, discount, description, available, image } =
          req.body;

        const query = { _id: new ObjectId(foodId) };
        const food = await foodsCollection.findOne(query);

        if (!food) {
          return res.status(404).json({ error: "Food not found" });
        }

        const updateDoc = {
          $set: {
            name,
            price,
            discount,
            description,
            available,
            image,
            updatedAt: new Date().toISOString(),
          },
        };

        const result = await foodsCollection.updateOne(query, updateDoc);

        res.send(result);
      } catch (_) {
        res.status(500).json({ error: "Internal server error" });
      }
    });

    app.delete("/foods/:id", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;

        const result = await foodsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send(result);
      } catch (err) {
        res
          .status(500)
          .send({ message: "Failed to delete food", error: err.message });
      }
    });

    // orders api
    app.get("/orders", verifyJwt, async (req, res) => {
      try {
        const { payment_status, status, email } = req.query;
        let { page = 1, limit = 10 } = req.query;

        page = parseInt(page);
        limit = parseInt(limit);

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        let query = { "customer.email": email };
        if ((payment_status, status)) {
          query = { payment_status, status };
        }

        const skip = (page - 1) * limit;

        const total = await ordersCollection.countDocuments(query);
        const orders = await ordersCollection
          .find(query)
          .sort({ placedAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        res.send({ orders, total });
      } catch (err) {
        res
          .status(500)
          .send({ message: "Internal server error", error: err.message });
      }
    });

    app.get("/orders/:id", verifyJwt, async (req, res) => {
      try {
        const { id } = req.params;

        const result = await ordersCollection.findOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (err) {
        res
          .status(500)
          .send({ message: "Internal server error", error: err.message });
      }
    });

    app.post("/orders", verifyJwt, async (req, res) => {
      try {
        const orderData = req.body;

        if (
          !orderData.customer ||
          !orderData.items ||
          !Array.isArray(orderData.items) ||
          orderData.items.length === 0
        ) {
          return res.status(400).send({ message: "Invalid order data" });
        }

        const result = await ordersCollection.insertOne(orderData);
        res.send(result);
      } catch (err) {
        res
          .status(500)
          .send({ message: "Internal server error", error: err.message });
      }
    });

    app.patch("/orders/:id", verifyJwt, async (req, res) => {
      try {
        const id = req.params.id;
        const { status } = req.body;

        if (!status) {
          return res.status(400).send({ message: "Status is required" });
        }

        if (status === "assigned" && req.user.role !== "admin") {
          return res.status(403).send({ message: "Forbidden: Admin only" });
        }

        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            status,
          },
        };

        // Add timestamps
        if (status === "cancelled")
          updateDoc.$set.cancelledAt = new Date().toISOString();
        if (status === "assigned")
          updateDoc.$set.assignedAt = new Date().toISOString();

        const result = await ordersCollection.updateOne(filter, updateDoc);

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "Order not found" });
        }

        res.send({
          message: "Order status updated",
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        res.status(500).send({
          message: "Failed to update order status",
          error: error.message,
        });
      }
    });

    app.patch(
      "/orders/:id/assign",
      verifyJwt,
      verifyAdmin,
      async (req, res) => {
        const orderId = req.params.id;
        const { riderId, riderName, riderEmail } = req.body;

        try {
          // Update order
          await ordersCollection.updateOne(
            { _id: new ObjectId(orderId) },
            {
              $set: {
                status: "assigned",
                assigned_rider_id: riderId,
                assigned_rider_name: riderName,
                assigned_rider_email: riderEmail,
                assignedAt: new Date().toISOString(),
              },
            }
          );

          // Update rider
          await ridersCollection.updateOne(
            { _id: new ObjectId(riderId) },
            {
              $set: {
                work_status: "in_delivery",
              },
            }
          );

          res.send({ message: "Rider assigned" });
        } catch (err) {
          res.status(500).send({ message: err.message });
        }
      }
    );

    app.patch(
      "/orders/:id/status",
      verifyJwt,
      verifyRider,
      async (req, res) => {
        const orderId = req.params.id;
        const { status } = req.body;
        const updatedDoc = {
          status,
        };

        if (status === "picked") {
          updatedDoc.pickedAt = new Date().toISOString();
        } else if (status === "delivered") {
          updatedDoc.deliveredAt = new Date().toISOString();
        }

        try {
          const result = await ordersCollection.updateOne(
            { _id: new ObjectId(orderId) },
            {
              $set: updatedDoc,
            }
          );

          if (status === "delivered") {
            const order = await ordersCollection.findOne({
              _id: new ObjectId(orderId),
            });

            const query = { _id: new ObjectId(order.assigned_rider_id) };
            const updateRiderWorkStatus = await ridersCollection.updateOne(
              query,
              { $set: { work_status: "available" } }
            );
          }

          res.send({ result });
        } catch (error) {
          res.status(500).send({ message: error.message });
        }
      }
    );

    app.patch(
      "/orders/:id/cashout",
      verifyJwt,
      verifyRider,
      async (req, res) => {
        const id = req.params.id;
        const result = await ordersCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              cashout_status: "cashed_out",
              cashedOutAt: new Date().toISOString(),
            },
          }
        );
        res.send(result);
      }
    );

    // payments api
    app.post("/payments", verifyJwt, async (req, res) => {
      try {
        const { orderId, email, amount, paymentMethod, transactionId } =
          req.body;

        // 1. Update order's payment_status
        const updateResult = await ordersCollection.updateOne(
          { _id: new ObjectId(orderId) },
          {
            $set: {
              payment_status: "paid",
              status: "not_assigned",
              paidAt: new Date().toISOString(),
            },
          }
        );

        if (updateResult.modifiedCount === 0) {
          return res
            .status(404)
            .send({ message: "Order not found or already paid" });
        }

        // 2. Insert payment record
        const paymentDoc = {
          orderId,
          email,
          amount,
          paymentMethod,
          transactionId,
          paidAt: new Date().toISOString(),
          status: "payment done",
        };

        const paymentResult = await paymentsCollection.insertOne(paymentDoc);

        res.status(201).send({
          message: "Payment recorded and parcel marked as paid",
          insertedId: paymentResult.insertedId,
        });
      } catch (error) {
        res.status(500).send({ message: "Failed to record payment" });
      }
    });

    // riders api
    app.get("/riders/pending", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .toArray();

        res.send(pendingRiders);
      } catch (error) {
        res.status(500).send({ message: "Failed to load pending riders" });
      }
    });

    app.get("/riders/available", verifyJwt, verifyAdmin, async (req, res) => {
      const { thana } = req.query;

      try {
        const riders = await ridersCollection
          .find({
            thana,
            status: "active",
            work_status: "available",
          })
          .toArray();

        res.send(riders);
      } catch (err) {
        res.status(500).send({ message: "Failed to load riders" });
      }
    });

    app.get("/rider/orders", verifyJwt, verifyRider, async (req, res) => {
      try {
        const email = req.query.email;
        let { page = 1, limit = 10 } = req.query;

        page = parseInt(page);
        limit = parseInt(limit);

        if (!email) {
          return res.status(400).send({ message: "Rider email is required" });
        }

        const skip = (page - 1) * limit;

        const query = {
          assigned_rider_email: email,
          status: { $in: ["assigned", "picked"] },
        };

        const total = await ordersCollection.countDocuments(query);

        const orders = await ordersCollection
          .find(query)
          .sort({ placedAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();
        res.send({ orders, total });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.get(
      "/rider/completedOrders",
      verifyJwt,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.query.email;
          let { page = 1, limit = 10 } = req.query;

          page = parseInt(page);
          limit = parseInt(limit);

          if (!email) {
            return res.status(400).send({ message: "Rider email is required" });
          }

          const skip = (page - 1) * limit;

          const query = {
            assigned_rider_email: email,
            status: "delivered",
          };

          const total = await ordersCollection.countDocuments(query);
          const orders = await ordersCollection
            .find(query)
            .sort({ deliveredAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();

          res.send({ orders, total });
        } catch (error) {
          res.status(500).send({ message: error.message });
        }
      }
    );

    app.post("/riders", verifyJwt, verifyCustomer, async (req, res) => {
      try {
        const { email } = req.body;

        // Check if already applied
        const exists = await ridersCollection.findOne({ email });
        if (exists) {
          return res.send({ message: "You have already applied." });
        }

        const newCandidate = req.body;

        const result = await ridersCollection.insertOne(newCandidate);
        res.send(result);
      } catch (error) {
        res.status(500).json({ message: error.message });
      }
    });

    app.patch(
      "/riders/:id/status",
      verifyJwt,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { status = "active", email } = req.body;
        const query = { _id: new ObjectId(id) };

        const updatedDoc = {
          $set: {
            status,
            work_status: "available",
            activeAt: new Date().toISOString(),
          },
        };

        try {
          const result = await ridersCollection.updateOne(query, updatedDoc);

          const userQuery = { email };
          const updatedUserDoc = {
            $set: {
              role: "rider",
            },
          };
          const updatedRoleResult = await usersCollection.updateOne(
            userQuery,
            updatedUserDoc
          );

          res.send(result);
        } catch (err) {
          res.status(500).send({ message: "Failed to update rider status" });
        }
      }
    );

    app.delete("/riders/:id", verifyJwt, verifyAdmin, async (req, res) => {
      try {
        const query = { _id: new ObjectId(req.params.id) };

        const result = await ridersCollection.deleteOne(query);
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update rider status" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB!");
  } finally {
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Sam's Kitchen running on port ${port}`);
});
