import express from "express";
const router = express.Router();
import { ObjectId } from "mongodb";
import { ADMIN_EMAIL } from "../config/admin.js";
import verifyJwt from "../middleware/verifyJwt.js";
import { verifyAdmin, verifyRider } from "../middleware/verifyRole.js";
import { saveNotification } from "../services/notifications.js";
import { escapeRegex, orderSearchClause, pageParams, searchTerm, withClauses } from "../utils/queryHelpers.js";
import { parseRiderProfile, text } from "../utils/riderProfile.js";

export default (
  ridersCollection,
  usersCollection,
  ordersCollection,
  notificationsCollection,
  rolesCollection
) => {
  router.get("/pending", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      const { page, limit } = pageParams(req.query);
      const term = searchTerm(req.query.search);
      const status = req.query.status === "rejected" ? "rejected" : "pending";
      const query = { status };
      if (term) {
        const pattern = new RegExp(escapeRegex(term), "i");
        query.$or = [
          { name: pattern },
          { email: pattern },
          { phone: pattern },
          { thana: pattern },
          { district: pattern },
        ];
      }
      if (req.query.region) query.region = String(req.query.region);
      if (req.query.district) query.district = String(req.query.district);

      const dateField = status === "rejected" ? "rejectedAt" : "appliedAt";
      const sorts = { newest: { [dateField]: -1 }, oldest: { [dateField]: 1 }, name: { name: 1 } };
      const [pendingRiders, total, allPending, allRejected] = await Promise.all([
        ridersCollection
          .find(query)
          .sort(sorts[req.query.sort] || sorts.newest)
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        ridersCollection.countDocuments(query),
        ridersCollection.countDocuments({ status: "pending" }),
        ridersCollection.countDocuments({ status: "rejected" }),
      ]);
      res.send({ pendingRiders, total, allPending, allRejected });
    } catch (error) {
      res.status(500).send({ message: "Failed to load pending riders" });
    }
  });

  router.get("/me", verifyJwt, verifyRider, async (req, res) => {
    try {
      const rider = await ridersCollection.findOne(
        { email: req.user.email },
        {
          projection: {
            name: 1, email: 1, phone: 1, age: 1, experience: 1, region: 1, district: 1, thana: 1,
            status: 1, work_status: 1, is_available: 1, rejectionReason: 1, rejectedAt: 1, appliedAt: 1,
          },
        }
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
      const query = withClauses(
        {
          payment_status: "paid",
          status: "prepared",
          "customer.address.thana": rider.thana,
        },
        orderSearchClause(req.query.search),
      );
      const [offers, total] = await Promise.all([
        ordersCollection
          .find(query)
          .sort({ placedAt: req.query.sort === "newest" ? -1 : 1 })
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
      const query = withClauses(
        {
          assigned_rider_email: email,
          status: { $in: ["assigned", "picked"] },
        },
        orderSearchClause(req.query.search),
      );

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
      const query = withClauses(
        { assigned_rider_email: email, status: "delivered" },
        orderSearchClause(req.query.search),
      );
      const sorts = {
        newest: { deliveredAt: -1 },
        oldest: { deliveredAt: 1 },
        highest: { total: -1 },
      };

      const total = await ordersCollection.countDocuments(query);
      const orders = await ordersCollection
        .find(query)
        .sort(sorts[req.query.sort] || sorts.newest)
        .skip(skip)
        .limit(limit)
        .toArray();

      res.send({ orders, total });
    } catch (error) {
      res.status(500).send({ message: error.message });
    }
  });

  router.patch("/:id/status", verifyJwt, verifyAdmin, async (req, res) => {
    const { id } = req.params;
    const { email } = req.body;
    const query = { _id: new ObjectId(id), status: { $in: ["pending", "rejected"] } };

    const updatedDoc = {
      $set: {
        status: "active",
        work_status: "available",
        is_available: true,
        activeAt: new Date().toISOString(),
      },
      $unset: { rejectionReason: "", rejectedAt: "" },
    };

    try {
      const result = await ridersCollection.updateOne(query, updatedDoc);
      if (!result.matchedCount) {
        return res.status(404).send({ message: "Application not found or already approved" });
      }
      const user = await usersCollection.findOne({ email });
      if (!user) {
        return res.status(404).send({ message: "User not found" });
      }

      // Rider accounts chose their role at onboarding; this also covers
      // applications that were filed before onboarding existed.
      const riderRole = await rolesCollection.findOne({ requiresApproval: true });
      if (riderRole) {
        await usersCollection.updateOne(
          { email, role: { $ne: "admin" } },
          { $set: { role: riderRole.key } }
        );
      }

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

  // The admin turns an application down. The account keeps its rider role and
  // the rider can read the reason and apply again.
  router.patch("/:id/reject", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      const reason = text(req.body?.reason).slice(0, 300);
      const rejectedAt = new Date().toISOString();
      const rider = await ridersCollection.findOneAndUpdate(
        { _id: new ObjectId(req.params.id), status: "pending" },
        { $set: { status: "rejected", rejectedAt, rejectionReason: reason } },
        { returnDocument: "after" }
      );
      if (!rider) {
        return res.status(404).send({ message: "Application not found or already reviewed" });
      }

      await saveNotification(notificationsCollection, {
        type: "direct",
        email: rider.email,
        message: reason
          ? `Your rider application was not approved. Reason: ${reason}. You can update your details and apply again.`
          : "Your rider application was not approved. You can update your details and apply again.",
        relatedId: rider._id.toString(),
        createdAt: rejectedAt,
        isRead: false,
      });
      await saveNotification(notificationsCollection, {
        type: "direct",
        email: ADMIN_EMAIL,
        message: `You rejected ${rider.name}'s rider application.`,
        relatedId: rider._id.toString(),
        createdAt: rejectedAt,
        isRead: false,
      });

      res.send({ success: true });
    } catch (err) {
      res.status(500).send({ message: "Failed to reject the application" });
    }
  });

  // A rejected rider updates their details and goes back into the review queue.
  router.post("/reapply", verifyJwt, verifyRider, async (req, res) => {
    try {
      const { profile, error } = parseRiderProfile(req.body);
      if (error) return res.status(400).send({ message: error });

      const appliedAt = new Date().toISOString();
      const rider = await ridersCollection.findOneAndUpdate(
        { email: req.user.email, status: "rejected" },
        {
          $set: { ...profile, status: "pending", appliedAt, resubmittedAt: appliedAt },
          $unset: { rejectionReason: "", rejectedAt: "" },
        },
        { returnDocument: "after" }
      );
      if (!rider) {
        return res.status(409).send({ message: "There is no rejected application to resubmit." });
      }

      await saveNotification(notificationsCollection, {
        type: "direct",
        email: rider.email,
        message: "Your rider application was sent again and is waiting for review.",
        relatedId: rider._id.toString(),
        createdAt: appliedAt,
        isRead: false,
      });
      await saveNotification(notificationsCollection, {
        type: "direct",
        email: ADMIN_EMAIL,
        message: `${rider.name} updated their details and applied again to become a rider.`,
        relatedId: rider._id.toString(),
        createdAt: appliedAt,
        isRead: false,
      });

      res.send({ success: true });
    } catch (err) {
      res.status(500).send({ message: "Failed to send the application again" });
    }
  });

  // A rider whose application is pending or rejected can drop it and go back to the default role.
  router.post("/withdraw", verifyJwt, verifyRider, async (req, res) => {
    try {
      const rider = await ridersCollection.findOne({ email: req.user.email });
      if (!rider || rider.status === "active") {
        return res.status(409).send({ message: "Only an application under review or rejected can be withdrawn." });
      }

      const defaultRole = await rolesCollection.findOne({ isDefault: true });
      if (!defaultRole) {
        return res.status(500).send({ message: "No default role is set." });
      }

      await ridersCollection.deleteOne({ _id: rider._id });
      await usersCollection.updateOne({ email: req.user.email }, { $set: { role: defaultRole.key } });
      res.send({ success: true, role: defaultRole.key });
    } catch (err) {
      res.status(500).send({ message: "Failed to withdraw the application" });
    }
  });

  return router;
};
