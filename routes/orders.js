const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const verifyJwt = require("../middleware/verifyJwt");
const verifyAdmin = require("../middleware/verifyAdmin");
const verifyRider = require("../middleware/verifyRider");

module.exports = (ordersCollection, ridersCollection) => {
  router.get("/", verifyJwt, async (req, res) => {
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
      res.status(500).send({ message: "Internal server error", error: err.message });
    }
  });

  router.get("/:id", verifyJwt, async (req, res) => {
    try {
      const { id } = req.params;
      const result = await ordersCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    } catch (err) {
      res.status(500).send({ message: "Internal server error", error: err.message });
    }
  });

  router.post("/", verifyJwt, async (req, res) => {
    try {
      const orderData = req.body;

      if (!orderData.customer || !orderData.items || !Array.isArray(orderData.items) || orderData.items.length === 0) {
        return res.status(400).send({ message: "Invalid order data" });
      }

      const result = await ordersCollection.insertOne(orderData);
      res.send(result);
    } catch (err) {
      res.status(500).send({ message: "Internal server error", error: err.message });
    }
  });

  router.patch("/:id", verifyJwt, async (req, res) => {
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
        $set: { status },
      };

      if (status === "cancelled") updateDoc.$set.cancelledAt = new Date().toISOString();
      if (status === "assigned") updateDoc.$set.assignedAt = new Date().toISOString();

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

  router.patch("/:id/assign", verifyJwt, verifyAdmin, async (req, res) => {
    const orderId = req.params.id;
    const { riderId, riderName, riderEmail } = req.body;

    try {
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

      await ridersCollection.updateOne(
        { _id: new ObjectId(riderId) },
        { $set: { work_status: "in_delivery" } }
      );

      res.send({ message: "Rider assigned" });
    } catch (err) {
      res.status(500).send({ message: err.message });
    }
  });

  router.patch("/:id/status", verifyJwt, verifyRider, async (req, res) => {
    const orderId = req.params.id;
    const { status } = req.body;
    const updatedDoc = { status };

    if (status === "picked") {
      updatedDoc.pickedAt = new Date().toISOString();
    } else if (status === "delivered") {
      updatedDoc.deliveredAt = new Date().toISOString();
    }

    try {
      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(orderId) },
        { $set: updatedDoc }
      );

      if (status === "delivered") {
        const order = await ordersCollection.findOne({ _id: new ObjectId(orderId) });
        const query = { _id: new ObjectId(order.assigned_rider_id) };
        await ridersCollection.updateOne(query, { $set: { work_status: "available" } });
      }

      res.send({ result });
    } catch (error) {
      res.status(500).send({ message: error.message });
    }
  });

  router.patch("/:id/cashout", verifyJwt, verifyRider, async (req, res) => {
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
  });

  return router;
};