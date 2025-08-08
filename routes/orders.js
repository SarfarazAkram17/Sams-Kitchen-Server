const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const verifyJwt = require("../middleware/verifyJwt");
const verifyAdmin = require("../middleware/verifyAdmin");
const verifyRider = require("../middleware/verifyRider");

module.exports = (
  ordersCollection,
  ridersCollection,
  notificationsCollection
) => {
  router.get("/", verifyJwt, async (req, res) => {
    try {
      const { payment_status, status, email } = req.query;
      let { page = 1, limit = 12 } = req.query;

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

  router.get("/:id", verifyJwt, async (req, res) => {
    try {
      const { id } = req.params;
      const result = await ordersCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    } catch (err) {
      res
        .status(500)
        .send({ message: "Internal server error", error: err.message });
    }
  });

  router.post("/", verifyJwt, async (req, res) => {
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

      const notificationForUser = {
        type: "direct",
        email: orderData.customer.email,
        message: `Your order is placed successfully.`,
        relatedId: result.insertedId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await notificationsCollection.insertOne(notificationForUser);

      const notificationForAdmin = {
        type: "direct",
        email: "sarfarazakram16@gmail.com",
        message: `New order is placed.`,
        relatedId: result.insertedId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await notificationsCollection.insertOne(notificationForAdmin);

      res.send(result);
    } catch (err) {
      res
        .status(500)
        .send({ message: "Internal server error", error: err.message });
    }
  });

  router.patch("/:id", verifyJwt, async (req, res) => {
    try {
      const id = req.params.id;
      const { status } = req.body;

      if (!status) {
        return res.status(400).send({ message: "Status is required" });
      }

      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { status, cancelledAt: new Date().toISOString() },
      };
      const result = await ordersCollection.updateOne(filter, updateDoc);

      if (result.matchedCount === 0) {
        return res.status(404).send({ message: "Order not found" });
      }

      const notificationForUser = {
        type: "direct",
        email: req.query.email,
        message: `You cancelled a order.`,
        relatedId: id.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await notificationsCollection.insertOne(notificationForUser);

      const notificationForAdmin = {
        type: "direct",
        email: "sarfarazakram16@gmail.com",
        message: `Order cancelled.`,
        relatedId: id.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await notificationsCollection.insertOne(notificationForAdmin);

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
      const order = await ordersCollection.findOne({
        _id: new ObjectId(orderId),
      });

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

      const notificationForUser = {
        type: "direct",
        email: order.customer.email,
        message: `Your order is assigned to rider: ${riderName}.`,
        relatedId: orderId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await notificationsCollection.insertOne(notificationForUser);

      const notificationForAdmin = {
        type: "direct",
        email: "sarfarazakram16@gmail.com",
        message: `You assigned rider to a order successfully.`,
        relatedId: orderId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };
      await notificationsCollection.insertOne(notificationForAdmin);

      await ridersCollection.updateOne(
        { _id: new ObjectId(riderId) },
        { $set: { work_status: "in_delivery" } }
      );

      const notificationForRider = {
        type: "direct",
        email: riderEmail,
        message: `You are assigned for a order. Go to the outlet and pick the order.`,
        relatedId: orderId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };
      await notificationsCollection.insertOne(notificationForRider);

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
      const order = await ordersCollection.findOne({
        _id: new ObjectId(orderId),
      });

      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(orderId) },
        { $set: updatedDoc }
      );

      if (status === "picked") {
        const notificationForUser = {
          type: "direct",
          email: order.customer.email,
          message: `Your order is picked by the rider.`,
          relatedId: orderId.toString(),
          createdAt: new Date().toISOString(),
          isRead: false,
        };

        await notificationsCollection.insertOne(notificationForUser);

        const notificationForAdmin = {
          type: "direct",
          email: "sarfarazakram16@gmail.com",
          message: `A order is picked by a rider.`,
          relatedId: orderId.toString(),
          createdAt: new Date().toISOString(),
          isRead: false,
        };

        await notificationsCollection.insertOne(notificationForAdmin);

        const notificationForRider = {
          type: "direct",
          email: req.query.email,
          message: `You picked a order.`,
          relatedId: orderId.toString(),
          createdAt: new Date().toISOString(),
          isRead: false,
        };

        await notificationsCollection.insertOne(notificationForRider);
      }

      if (status === "delivered") {
        const query = { _id: new ObjectId(order.assigned_rider_id) };
        await ridersCollection.updateOne(query, {
          $set: { work_status: "available" },
        });

        const notificationForUser = {
          type: "direct",
          email: order.customer.email,
          message: `Your order is delivered.`,
          relatedId: orderId.toString(),
          createdAt: new Date().toISOString(),
          isRead: false,
        };

        await notificationsCollection.insertOne(notificationForUser);

        const notificationForAdmin = {
          type: "direct",
          email: "sarfarazakram16@gmail.com",
          message: `A order is delivered by a rider.`,
          relatedId: orderId.toString(),
          createdAt: new Date().toISOString(),
          isRead: false,
        };

        await notificationsCollection.insertOne(notificationForAdmin);

        const notificationForRider = {
          type: "direct",
          email: req.query.email,
          message: `You Delivered a order.`,
          relatedId: orderId.toString(),
          createdAt: new Date().toISOString(),
          isRead: false,
        };

        await notificationsCollection.insertOne(notificationForRider);
      }
      res.send({ result });
    } catch (error) {
      res.status(500).send({ message: error.message });
    }
  });

  router.patch("/:id/cashout", verifyJwt, verifyRider, async (req, res) => {
    const id = req.params.id;
    const order = await ordersCollection.findOne({ _id: new ObjectId(id) });

    const result = await ordersCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          cashout_status: "cashed_out",
          cashedOutAt: new Date().toISOString(),
        },
      }
    );

    const notificationForRider = {
      type: "direct",
      email: order.assigned_rider_email,
      message: `You cashout your earnings for a order.`,
      relatedId: id.toString(),
      createdAt: new Date().toISOString(),
      isRead: false,
    };

    await notificationsCollection.insertOne(notificationForRider);

    const notificationForAdmin = {
      type: "direct",
      email: "sarfarazakram16@gmail.com",
      message: `Rider cashout his earnings. Rider name: ${order.assigned_rider_name}. Rider email: ${order.assigned_rider_email}.`,
      relatedId: id.toString(),
      createdAt: new Date().toISOString(),
      isRead: false,
    };

    await notificationsCollection.insertOne(notificationForAdmin);

    res.send(result);
  });

  return router;
};
