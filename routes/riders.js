const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const verifyJwt = require("../middleware/verifyJwt");
const verifyAdmin = require("../middleware/verifyAdmin");
const verifyCustomer = require("../middleware/verifyCustomer");
const verifyRider = require("../middleware/verifyRider");

module.exports = (ridersCollection, usersCollection, ordersCollection) => {
  router.get("/pending", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      let { page = 1, limit = 10 } = req.query;

      page = parseInt(page);
      limit = parseInt(limit);

      const skip = (page - 1) * limit;
      const total = await ordersCollection.countDocuments(query);

      const pendingRiders = await ridersCollection
        .find({ status: "pending" })
        .skip(skip)
        .limit(limit)
        .toArray();
      res.send({pendingRiders, total});
    } catch (error) {
      res.status(500).send({ message: "Failed to load pending riders" });
    }
  });

  router.get("/available", verifyJwt, verifyAdmin, async (req, res) => {
    const { thana } = req.query;
    try {
      const riders = await ridersCollection
        .find({ thana, status: "active", work_status: "available" })
        .toArray();
      res.send(riders);
    } catch (err) {
      res.status(500).send({ message: "Failed to load riders" });
    }
  });

  router.get("/orders", verifyJwt, verifyRider, async (req, res) => {
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

  router.get("/completedOrders", verifyJwt, verifyRider, async (req, res) => {
    try {
      const email = req.query.email;
      let { page = 1, limit = 10 } = req.query;

      page = parseInt(page);
      limit = parseInt(limit);

      if (!email) {
        return res.status(400).send({ message: "Rider email is required" });
      }

      const skip = (page - 1) * limit;
      const query = { assigned_rider_email: email, status: "delivered" };

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
  });

  router.post("/", verifyJwt, verifyCustomer, async (req, res) => {
    try {
      const { email } = req.body;
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

  router.patch("/:id/status", verifyJwt, verifyAdmin, async (req, res) => {
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
      const updatedUserDoc = { $set: { role: "rider" } };
      await usersCollection.updateOne(userQuery, updatedUserDoc);
      res.send(result);
    } catch (err) {
      res.status(500).send({ message: "Failed to update rider status" });
    }
  });

  router.delete("/:id", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      const query = { _id: new ObjectId(req.params.id) };
      const result = await ridersCollection.deleteOne(query);
      res.send(result);
    } catch (err) {
      res.status(500).send({ message: "Failed to update rider status" });
    }
  });

  return router;
};
