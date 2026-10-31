import express from "express";
const router = express.Router();
import { ObjectId } from "mongodb";
import { ADMIN_EMAIL } from "../config/admin.js";
import verifyJwt from "../middleware/verifyJwt.js";
import verifyAdmin from "../middleware/verifyAdmin.js";
import verifyCustomer from "../middleware/verifyCustomer.js";
import verifyRider from "../middleware/verifyRider.js";
import { saveNotification } from "../services/notifications.js";

export default (
  ridersCollection,
  usersCollection,
  ordersCollection,
  notificationsCollection
) => {
  router.get("/pending", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      let { page = 1, limit = 10 } = req.query;

      page = parseInt(page);
      limit = parseInt(limit);

      const skip = (page - 1) * limit;
      const total = await ridersCollection.countDocuments({
        status: "pending",
      });

      const pendingRiders = await ridersCollection
        .find({ status: "pending" })
        .skip(skip)
        .limit(limit)
        .toArray();
      res.send({ pendingRiders, total });
    } catch (error) {
      res.status(500).send({ message: "Failed to load pending riders" });
    }
  });

  router.get("/me", verifyJwt, verifyRider, async (req, res) => {
    try {
      const rider = await ridersCollection.findOne(
        { email: req.user.email },
        { projection: { name: 1, email: 1, phone: 1, region: 1, district: 1, thana: 1, status: 1, work_status: 1, is_available: 1 } }
      );
      if (!rider) return res.status(404).send({ message: "Rider profile not found" });
      res.send(rider);
    } catch (error) {
      res.status(500).send({ message: "Failed to load rider profile" });
    }
  });

  router.get("/offers", verifyJwt, verifyRider, async (req, res) => {
    try {
      const rider = await ridersCollection.findOne({
        email: req.user.email,
        status: "active",
      });
      if (!rider) return res.status(403).send({ message: "Active rider account required" });
      if (rider.work_status !== "available" || rider.is_available === false) {
        return res.send({ offers: [], total: 0 });
      }

      const { page = 1, limit = 10 } = req.query;
      const pageNumber = Math.max(1, Number.parseInt(page, 10) || 1);
      const pageLimit = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 10));
      const query = {
        payment_status: "paid",
        status: "prepared",
        "customer.address.thana": rider.thana,
      };
      const [offers, total] = await Promise.all([
        ordersCollection
          .find(query)
          .sort({ placedAt: 1 })
          .skip((pageNumber - 1) * pageLimit)
          .limit(pageLimit)
          .toArray(),
        ordersCollection.countDocuments(query),
      ]);
      res.send({ offers, total });
    } catch (error) {
      res.status(500).send({ message: "Failed to load delivery offers" });
    }
  });

  router.patch("/me/availability", verifyJwt, verifyRider, async (req, res) => {
    const { available } = req.body;
    if (typeof available !== "boolean") {
      return res.status(400).send({ message: "Availability must be true or false" });
    }

    try {
      const rider = await ridersCollection.findOne({
        email: req.user.email,
        status: "active",
      });
      if (!rider) return res.status(404).send({ message: "Active rider account not found" });

      const set = { is_available: available };
      if (rider.work_status !== "in_delivery") {
        set.work_status = available ? "available" : "unavailable";
      }
      const result = await ridersCollection.updateOne(
        { _id: rider._id, status: "active" },
        { $set: set }
      );
      res.send({ available, work_status: set.work_status || rider.work_status, modifiedCount: result.modifiedCount });
    } catch (error) {
      res.status(500).send({ message: "Failed to update availability" });
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

      const notificationForUser = {
        type: "direct",
        email: email,
        message: `You apply for become a rider of Sam's Kitchen.`,
        relatedId: result.insertedId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await saveNotification(notificationsCollection, notificationForUser);

      const notificationForAdmin = {
        type: "direct",
        email: ADMIN_EMAIL,
        message: `${newCandidate.name} apply to become a rider.`,
        relatedId: result.insertedId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await saveNotification(notificationsCollection, notificationForAdmin);

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
        is_available: true,
        activeAt: new Date().toISOString(),
      },
    };

    try {
      const result = await ridersCollection.updateOne(query, updatedDoc);
      const userQuery = { email };
      const user = await usersCollection.findOne(userQuery);
      const updatedUserDoc = { $set: { role: "rider" } };
      await usersCollection.updateOne(userQuery, updatedUserDoc);

      const notificationForUser = {
        type: "direct",
        email: user.email,
        message: `Your rider application is approved. Now you are a rider of Sam's Kitchen.`,
        relatedId: user._id.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await saveNotification(notificationsCollection, notificationForUser);

      const notificationForAdmin = {
        type: "direct",
        email: ADMIN_EMAIL,
        message: `You approved a rider application. Now ${user.name} is a rider.`,
        relatedId: user._id.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await saveNotification(notificationsCollection, notificationForAdmin);

      res.send(result);
    } catch (err) {
      res.status(500).send({ message: "Failed to update rider status" });
    }
  });

  router.delete("/:id", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      const query = { _id: new ObjectId(req.params.id) };
      const rider = await ridersCollection.findOne(query);

      const notificationForUser = {
        type: "direct",
        email: rider.email,
        message: `You are rejected from become a rider of Sam's Kitchen.`,
        relatedId: rider._id.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await saveNotification(notificationsCollection, notificationForUser);

      const notificationForAdmin = {
        type: "direct",
        email: ADMIN_EMAIL,
        message: `You rejected a rider application. Now ${rider.name} is rejected from become a rider of Sam's Kitchen.`,
        relatedId: rider._id.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await saveNotification(notificationsCollection, notificationForAdmin);

      const result = await ridersCollection.deleteOne(query);
      res.send(result);
    } catch (err) {
      res.status(500).send({ message: "Failed to update rider status" });
    }
  });

  return router;
};
