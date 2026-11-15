import express from "express";
const router = express.Router();
import { ObjectId } from "mongodb";
import { createHmac, randomInt, timingSafeEqual } from "crypto";
import verifyJwt from "../middleware/verifyJwt.js";
import {
  verifyAdmin,
  verifyCustomer,
  verifyRider,
} from "../middleware/verifyRole.js";
import { ADMIN_EMAIL } from "../config/admin.js";
import { client } from "../config/db.js";
import { saveNotification } from "../services/notifications.js";
import { sendDeliveryOtpEmail } from "../services/deliveryOtpEmail.js";
import {
  orderSearchClause,
  pageParams,
  withClauses,
} from "../utils/queryHelpers.js";
import { checkPromo, normalizeCode } from "../utils/promo.js";
import { buildOrderItems, calcTotals, whole } from "../utils/pricing.js";
import { parseCartLines, parseCustomer } from "../utils/orderInput.js";

const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "prepared",
  "assigned",
  "picked",
  "delivered",
  "cancelled",
];

// "2026-11-08" and a time of day, read in Bangladesh time (UTC+6), as the ISO
// string that placedAt is stored in. Anything that is not a real date gives null.
const dayBound = (day, time) => {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T${time}+06:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export default (
  ordersCollection,
  ridersCollection,
  notificationsCollection,
  deliveryOtpChallengesCollection,
  promosCollection,
  foodsCollection,
) => {
  const otpHashSecret = () => process.env.JWT_SECRET;
  const statusOtpId = (orderId, status) => `${orderId}:${status}`;
  const hashOtp = (code) =>
    createHmac("sha256", otpHashSecret()).update(code).digest("hex");

  router.get("/", verifyJwt, async (req, res) => {
    try {
      const { payment_status, status, search, sort } = req.query;
      let { page = 1, limit = 12 } = req.query;

      page = parseInt(page);
      limit = parseInt(limit);

      const customerQuery = { "customer.email": req.user.email };
      const ordersQuery = { ...customerQuery };
      if (payment_status) ordersQuery.payment_status = payment_status;
      if (status) ordersQuery.status = status;

      const skip = (page - 1) * limit;
      const listQuery = withClauses(ordersQuery, orderSearchClause(search));
      const sorts = {
        newest: { placedAt: -1 },
        oldest: { placedAt: 1 },
        highest: { total: -1 },
        lowest: { total: 1 },
      };

      const [total, orders, statusCountRows] = await Promise.all([
        ordersCollection.countDocuments(listQuery),
        ordersCollection
          .find(listQuery)
          .sort(sorts[sort] || sorts.newest)
          .skip(skip)
          .limit(limit)
          .toArray(),
        ordersCollection
          .aggregate([
            { $match: customerQuery },
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ])
          .toArray(),
      ]);

      const statusCounts = Object.fromEntries(
        statusCountRows
          .filter(({ _id }) => typeof _id === "string")
          .map(({ _id, count }) => [_id, count]),
      );
      const allTimeTotal = statusCountRows.reduce(
        (count, statusRow) => count + statusRow.count,
        0,
      );

      res.send({ orders, total, allTimeTotal, statusCounts });
    } catch (err) {
      res
        .status(500)
        .send({ message: "Internal server error", error: err.message });
    }
  });

  // Paid orders for the admin's Kitchen Orders page. `status` is "confirmed"
  // (to prepare, oldest first) or "prepared" (waiting for a rider, latest first).
  router.get("/kitchen", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      const status = req.query.status === "prepared" ? "prepared" : "confirmed";
      const { page, limit } = pageParams(req.query);
      const sortField = status === "prepared" ? "preparedAt" : "paidAt";
      const direction =
        req.query.sort === "oldest"
          ? 1
          : req.query.sort === "newest"
            ? -1
            : status === "confirmed"
              ? 1
              : -1;
      const baseQuery = { status, payment_status: "paid" };
      const listQuery = withClauses(
        baseQuery,
        orderSearchClause(req.query.search),
      );

      const [orders, confirmedCount, preparedCount, matched] =
        await Promise.all([
          ordersCollection
            .find(listQuery)
            .sort({ [sortField]: direction, _id: direction })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray(),
          ordersCollection.countDocuments({
            status: "confirmed",
            payment_status: "paid",
          }),
          ordersCollection.countDocuments({
            status: "prepared",
            payment_status: "paid",
          }),
          ordersCollection.countDocuments(listQuery),
        ]);

      res.send({
        orders,
        total: matched,
        counts: { confirmed: confirmedCount, prepared: preparedCount },
      });
    } catch (err) {
      res.status(500).send({ message: "Failed to load kitchen orders" });
    }
  });

  // Every order in the system, for the admin's All Orders page. Filters:
  // status, payment_status ("paid" | "unpaid"), from / to (YYYY-MM-DD, read as
  // Bangladesh days), search and sort. Counts and revenue help the page header.
  router.get("/all", verifyJwt, verifyAdmin, async (req, res) => {
    try {
      const { page, limit } = pageParams(req.query);
      const { status, payment_status: payment, from, to, sort } = req.query;

      const base = {};
      if (ORDER_STATUSES.includes(status)) base.status = status;
      if (payment === "paid") base.payment_status = "paid";
      if (payment === "unpaid") base.payment_status = { $ne: "paid" };

      const placed = {};
      const start = dayBound(from, "00:00:00.000");
      const end = dayBound(to, "23:59:59.999");
      if (start) placed.$gte = start;
      if (end) placed.$lte = end;
      if (start || end) base.placedAt = placed;

      const listQuery = withClauses(base, orderSearchClause(req.query.search));
      const sorts = {
        newest: { placedAt: -1, _id: -1 },
        oldest: { placedAt: 1, _id: 1 },
        highest: { total: -1, _id: -1 },
        lowest: { total: 1, _id: 1 },
      };

      const [orders, total, statusRows, revenueRows] = await Promise.all([
        ordersCollection
          .find(listQuery)
          .sort(sorts[sort] || sorts.newest)
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        ordersCollection.countDocuments(listQuery),
        ordersCollection
          .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])
          .toArray(),
        ordersCollection
          .aggregate([
            { $match: withClauses(listQuery, { payment_status: "paid" }) },
            { $group: { _id: null, revenue: { $sum: "$total" } } },
          ])
          .toArray(),
      ]);

      const statusCounts = Object.fromEntries(
        statusRows
          .filter(({ _id }) => typeof _id === "string")
          .map(({ _id, count }) => [_id, count]),
      );
      const allTimeTotal = statusRows.reduce((sum, row) => sum + row.count, 0);

      res.send({
        orders,
        total,
        statusCounts,
        allTimeTotal,
        revenue: revenueRows[0]?.revenue || 0,
      });
    } catch (err) {
      res.status(500).send({ message: "Failed to load orders" });
    }
  });

  router.patch("/:id/prepared", verifyJwt, verifyAdmin, async (req, res) => {
    const orderId = req.params.id;
    if (!ObjectId.isValid(orderId)) {
      return res.status(400).send({ message: "Invalid order ID" });
    }

    try {
      const order = await ordersCollection.findOneAndUpdate(
        {
          _id: new ObjectId(orderId),
          status: "confirmed",
          payment_status: "paid",
        },
        { $set: { status: "prepared", preparedAt: new Date().toISOString() } },
        { returnDocument: "after" },
      );
      if (!order) {
        return res
          .status(409)
          .send({ message: "This order is not waiting to be prepared" });
      }

      const thana = order.customer?.address?.thana;
      const riders = await ridersCollection
        .find({ thana, status: "active" })
        .project({ email: 1 })
        .toArray();
      const createdAt = new Date().toISOString();

      await Promise.all([
        saveNotification(notificationsCollection, {
          type: "direct",
          email: order.customer.email,
          message:
            "Your food is prepared. We are waiting for a rider to pick it up.",
          relatedId: orderId,
          createdAt,
          isRead: false,
        }),
        ...riders.map((rider) =>
          saveNotification(notificationsCollection, {
            type: "direct",
            email: rider.email,
            message: `A prepared order is ready for pickup in ${thana}. Check Pending Deliveries.`,
            relatedId: orderId,
            createdAt,
            isRead: false,
          }),
        ),
      ]);

      res.send({ message: "Order marked as prepared", order });
    } catch (err) {
      res.status(500).send({ message: "Failed to update order" });
    }
  });

  router.get("/:id", verifyJwt, async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid order ID" });
      }
      const result = await ordersCollection.findOne({ _id: new ObjectId(id) });
      if (
        !result ||
        (req.user.role !== "admin" &&
          result.customer?.email !== req.user.email &&
          result.assigned_rider_email !== req.user.email)
      ) {
        return res.status(404).send({ message: "Order not found" });
      }
      res.send(result);
    } catch (err) {
      res
        .status(500)
        .send({ message: "Internal server error", error: err.message });
    }
  });

  router.post("/", verifyJwt, verifyCustomer, async (req, res) => {
    try {
      const body = req.body || {};

      // The order is built here from the database. Dish names, images, prices and
      // discounts come from the foods, the email from the signed-in account, and
      // every total is worked out on the server. The browser only supplies the
      // cart (which dishes and how many) and the delivery details.
      const parsedCustomer = parseCustomer(body.customer, req.user.email);
      if (parsedCustomer.error) {
        return res.status(400).send({ message: parsedCustomer.error });
      }
      const parsedCart = parseCartLines(body.items);
      if (parsedCart.error) {
        return res.status(400).send({ message: parsedCart.error });
      }

      const foods = await foodsCollection
        .find({
          _id: {
            $in: parsedCart.lines.map((line) => new ObjectId(line.foodId)),
          },
        })
        .toArray();
      const foodsById = new Map(
        foods.map((food) => [food._id.toString(), food]),
      );

      if (parsedCart.lines.some((line) => !foodsById.has(line.foodId))) {
        return res
          .status(400)
          .send({
            message: "Some items in your cart are no longer on the menu.",
          });
      }

      const unavailable = parsedCart.lines
        .map((line) => foodsById.get(line.foodId))
        .filter((food) => food.available === false);
      if (unavailable.length > 0) {
        const names = unavailable.map((food) => food.name).join(", ");
        return res.status(409).send({
          code: "UNAVAILABLE",
          message: `${names} ${unavailable.length > 1 ? "are" : "is"} not available right now. Please remove ${unavailable.length > 1 ? "them" : "it"} from your cart.`,
        });
      }

      const items = buildOrderItems(parsedCart.lines, foodsById);
      const totals = calcTotals(items);

      // If the browser was showing different prices (a price changed while the
      // dishes sat in the cart), stop and let the customer review the new total.
      if (body.total !== undefined && whole(body.total) !== totals.total) {
        return res.status(409).send({
          code: "PRICE_CHANGED",
          message:
            "Some prices changed since you added these items. Please review your order and try again.",
        });
      }

      const orderData = {
        customer: parsedCustomer.data,
        items,
        subtotal: totals.subtotal,
        deliveryCharge: totals.deliveryCharge,
        discount: totals.discount,
        total: totals.total,
        payment_status: "not_paid",
        status: "pending",
        placedAt: new Date().toISOString(),
      };

      // Promo code: the discount is worked out here from the saved items, never
      // taken from the browser. The code is counted as used straight away, and
      // given back if the order cannot be saved or is cancelled while unpaid.
      const promoCode = normalizeCode(body.promoCode);
      let reservedPromoId = null;

      if (promoCode) {
        const promo = await promosCollection.findOne({ code: promoCode });
        if (!promo) {
          return res
            .status(400)
            .send({ message: "This promo code does not exist." });
        }

        const payable = items.reduce((sum, item) => sum + item.subtotal, 0);
        const check = checkPromo(promo, payable);
        if (!check.ok) return res.status(400).send({ message: check.message });

        const timesUsed = await ordersCollection.countDocuments({
          "customer.email": req.user.email,
          promoCode,
          status: { $ne: "cancelled" },
        });
        if (timesUsed >= (promo.perUserLimit || 1)) {
          return res
            .status(409)
            .send({ message: "You have already used this promo code." });
        }

        const reserved = await promosCollection.findOneAndUpdate(
          {
            _id: promo._id,
            active: true,
            $or: [
              { usageLimit: null },
              { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
            ],
          },
          { $inc: { usedCount: 1 } },
        );
        if (!reserved) {
          return res
            .status(409)
            .send({ message: "This promo code has reached its usage limit." });
        }

        reservedPromoId = promo._id;
        orderData.promoCode = promoCode;
        orderData.promoDiscount = check.discount;
        orderData.total = Math.max(0, orderData.total - check.discount);
      }

      let result;
      try {
        result = await ordersCollection.insertOne(orderData);
      } catch (insertError) {
        if (reservedPromoId) {
          await promosCollection.updateOne(
            { _id: reservedPromoId, usedCount: { $gt: 0 } },
            { $inc: { usedCount: -1 } },
          );
        }
        throw insertError;
      }

      const notificationForUser = {
        type: "direct",
        email: orderData.customer.email,
        message: `Your order is placed successfully.`,
        relatedId: result.insertedId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await saveNotification(notificationsCollection, notificationForUser);

      const notificationForAdmin = {
        type: "direct",
        email: ADMIN_EMAIL,
        message: `New order is placed.`,
        relatedId: result.insertedId.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await saveNotification(notificationsCollection, notificationForAdmin);

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

      if (status !== "cancelled") {
        return res
          .status(400)
          .send({ message: "Only order cancellation is supported here" });
      }

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid order ID" });
      }
      const filter = {
        _id: new ObjectId(id),
        "customer.email": req.user.email,
        payment_status: { $ne: "paid" },
        status: "pending",
      };
      const updateDoc = {
        $set: { status, cancelledAt: new Date().toISOString() },
      };
      const cancelled = await ordersCollection.findOneAndUpdate(
        filter,
        updateDoc,
        {
          projection: { promoCode: 1 },
        },
      );

      if (!cancelled) {
        return res
          .status(409)
          .send({ message: "This order cannot be cancelled" });
      }

      // A cancelled unpaid order gives its promo code use back.
      if (cancelled.promoCode) {
        await promosCollection.updateOne(
          { code: cancelled.promoCode, usedCount: { $gt: 0 } },
          { $inc: { usedCount: -1 } },
        );
      }

      const notificationForUser = {
        type: "direct",
        email: req.user.email,
        message: `You cancelled a order.`,
        relatedId: id.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await saveNotification(notificationsCollection, notificationForUser);

      const notificationForAdmin = {
        type: "direct",
        email: ADMIN_EMAIL,
        message: `Order cancelled.`,
        relatedId: id.toString(),
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      await saveNotification(notificationsCollection, notificationForAdmin);

      res.send({
        message: "Order status updated",
        modifiedCount: 1,
      });
    } catch (error) {
      res.status(500).send({
        message: "Failed to update order status",
        error: error.message,
      });
    }
  });

  router.post("/:id/accept", verifyJwt, verifyRider, async (req, res) => {
    const orderId = req.params.id;
    if (!ObjectId.isValid(orderId)) {
      return res.status(400).send({ message: "Invalid order ID" });
    }

    const session = client.startSession();
    try {
      let acceptedOrder;
      let acceptedRider;
      await session.withTransaction(async () => {
        acceptedRider = await ridersCollection.findOneAndUpdate(
          {
            email: req.user.email,
            status: "active",
            work_status: "available",
            is_available: { $ne: false },
          },
          { $set: { work_status: "in_delivery" } },
          { session, returnDocument: "after" },
        );
        if (!acceptedRider) {
          const error = new Error("RIDER_UNAVAILABLE");
          throw error;
        }

        acceptedOrder = await ordersCollection.findOneAndUpdate(
          {
            _id: new ObjectId(orderId),
            status: "prepared",
            payment_status: "paid",
            "customer.address.thana": acceptedRider.thana,
          },
          {
            $set: {
              status: "assigned",
              assigned_rider_id: acceptedRider._id.toString(),
              assigned_rider_name: acceptedRider.name,
              assigned_rider_email: acceptedRider.email,
              assignedAt: new Date().toISOString(),
            },
          },
          { session, returnDocument: "after" },
        );
        if (!acceptedOrder) {
          const error = new Error("OFFER_UNAVAILABLE");
          throw error;
        }
      });

      if (!acceptedOrder || !acceptedRider) {
        return res
          .status(409)
          .send({ message: "This delivery offer is no longer available" });
      }

      const createdAt = new Date().toISOString();
      await Promise.all([
        saveNotification(notificationsCollection, {
          type: "direct",
          email: acceptedOrder.customer.email,
          message: `${acceptedRider.name} accepted your delivery.`,
          relatedId: orderId,
          createdAt,
          isRead: false,
        }),
        saveNotification(notificationsCollection, {
          type: "direct",
          email: acceptedRider.email,
          message: "Delivery accepted. Go to the outlet to pick up the order.",
          relatedId: orderId,
          createdAt,
          isRead: false,
        }),
        saveNotification(notificationsCollection, {
          type: "direct",
          email: ADMIN_EMAIL,
          message: `A rider accepted an order for ${acceptedOrder.customer.address.thana}.`,
          relatedId: orderId,
          createdAt,
          isRead: false,
        }),
      ]);
      res.send({ message: "Delivery accepted", order: acceptedOrder });
    } catch (err) {
      if (err.message === "RIDER_UNAVAILABLE") {
        return res
          .status(409)
          .send({ message: "You are unavailable or already delivering" });
      }
      if (err.message === "OFFER_UNAVAILABLE") {
        return res
          .status(409)
          .send({ message: "This delivery offer was already accepted" });
      }
      res.status(500).send({ message: err.message });
    } finally {
      await session.endSession();
    }
  });

  router.post("/:id/status-otp", verifyJwt, verifyRider, async (req, res) => {
    const { status } = req.body || {};
    const orderId = req.params.id;
    const allowedTransitions = { assigned: "picked", picked: "delivered" };

    if (!ObjectId.isValid(orderId)) {
      return res.status(400).send({ message: "Invalid order ID" });
    }
    if (!["picked", "delivered"].includes(status)) {
      return res.status(400).send({ message: "Invalid delivery status" });
    }
    if (!otpHashSecret()) {
      return res.status(503).send({
        message: "Delivery verification is not configured on the server.",
      });
    }

    try {
      const order = await ordersCollection.findOne({
        _id: new ObjectId(orderId),
        assigned_rider_email: req.user.email,
      });
      if (!order) {
        return res.status(404).send({ message: "Assigned order not found" });
      }
      if (allowedTransitions[order.status] !== status) {
        return res.status(409).send({
          message: "This delivery status cannot be updated.",
        });
      }

      const recipient =
        status === "picked" ? ADMIN_EMAIL : order.customer?.email;
      if (!recipient) {
        return res.status(422).send({
          message:
            status === "picked"
              ? "The admin email is not configured."
              : "This order has no customer email address.",
        });
      }

      const now = new Date();
      const challengeId = statusOtpId(orderId, status);
      const code = String(randomInt(100000, 1000000));
      const cooldownBefore = new Date(now.getTime() - 60 * 1000);
      const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);

      try {
        const challengeResult = await deliveryOtpChallengesCollection.updateOne(
          { _id: challengeId, requestedAt: { $lte: cooldownBefore } },
          {
            $set: {
              orderId,
              status,
              riderEmail: req.user.email,
              codeHash: hashOtp(code),
              requestedAt: now,
              expiresAt,
              attempts: 0,
            },
          },
          { upsert: true },
        );
        if (!challengeResult.matchedCount && !challengeResult.upsertedCount) {
          return res.status(429).send({
            message: "Please wait before requesting another code.",
            retryAfterSeconds: 60,
          });
        }
      } catch (error) {
        if (error.code === 11000) {
          return res.status(429).send({
            message: "Please wait before requesting another code.",
            retryAfterSeconds: 60,
          });
        }
        throw error;
      }

      try {
        await sendDeliveryOtpEmail({
          to: recipient,
          code,
          status,
          orderId,
        });
      } catch (error) {
        await deliveryOtpChallengesCollection.deleteOne({
          _id: challengeId,
          codeHash: hashOtp(code),
        });
        console.error("Delivery verification email could not be sent.");
        return res.status(503).send({
          message:
            error.code === "SMTP_NOT_CONFIGURED"
              ? "Email delivery is not configured. Please contact the administrator."
              : "The verification email could not be sent. Please try again.",
        });
      }

      return res.send({
        message:
          status === "picked"
            ? "A pickup verification code was emailed to the admin."
            : "A delivery verification code was emailed to the customer.",
        expiresAt: expiresAt.toISOString(),
        retryAfterSeconds: 60,
      });
    } catch (error) {
      console.error("Failed to request a delivery verification code.");
      return res.status(500).send({
        message: "Could not send the verification code.",
      });
    }
  });

  router.patch("/:id/status", verifyJwt, verifyRider, async (req, res) => {
    const orderId = req.params.id;
    const { status, otp } = req.body || {};
    const allowedTransitions = { assigned: "picked", picked: "delivered" };
    if (!["picked", "delivered"].includes(status)) {
      return res.status(400).send({ message: "Invalid delivery status" });
    }
    if (!ObjectId.isValid(orderId)) {
      return res.status(400).send({ message: "Invalid order ID" });
    }
    if (typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
      return res.status(400).send({
        message: "Enter the six-digit verification code.",
      });
    }
    if (!otpHashSecret()) {
      return res.status(503).send({
        message: "Delivery verification is not configured on the server.",
      });
    }
    const updatedDoc = { status };

    if (status === "picked") {
      updatedDoc.pickedAt = new Date().toISOString();
    } else if (status === "delivered") {
      updatedDoc.deliveredAt = new Date().toISOString();
    }

    try {
      const order = await ordersCollection.findOne({
        _id: new ObjectId(orderId),
        assigned_rider_email: req.user.email,
      });
      if (!order)
        return res.status(404).send({ message: "Assigned order not found" });
      if (allowedTransitions[order.status] !== status) {
        return res
          .status(409)
          .send({ message: "This delivery status cannot be updated" });
      }

      const challengeId = statusOtpId(orderId, status);
      const now = new Date();
      const challenge = await deliveryOtpChallengesCollection.findOne({
        _id: challengeId,
        riderEmail: req.user.email,
        expiresAt: { $gt: now },
      });
      if (!challenge) {
        await deliveryOtpChallengesCollection.deleteOne({
          _id: challengeId,
          expiresAt: { $lte: now },
        });
        return res.status(410).send({
          message: "The code is missing or expired. Request a new code.",
        });
      }

      const challengeAttempt =
        await deliveryOtpChallengesCollection.findOneAndUpdate(
          {
            _id: challengeId,
            riderEmail: req.user.email,
            expiresAt: { $gt: now },
            attempts: { $lt: 5 },
            codeHash: challenge.codeHash,
          },
          { $inc: { attempts: 1 } },
          { returnDocument: "after" },
        );
      if (!challengeAttempt) {
        return res.status(429).send({
          message: "Too many attempts. Request a new verification code.",
        });
      }

      const submittedHash = Buffer.from(hashOtp(otp), "hex");
      const expectedHash = Buffer.from(challenge.codeHash, "hex");
      const codeIsValid =
        submittedHash.length === expectedHash.length &&
        timingSafeEqual(submittedHash, expectedHash);

      if (!codeIsValid) {
        const attemptsRemaining = Math.max(0, 5 - challengeAttempt.attempts);
        if (!attemptsRemaining) {
          await deliveryOtpChallengesCollection.deleteOne({
            _id: challengeId,
            riderEmail: req.user.email,
          });
        }
        return res.status(attemptsRemaining ? 400 : 429).send({
          message: attemptsRemaining
            ? `Incorrect code. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? "" : "s"} remaining.`
            : "Too many attempts. Request a new verification code.",
        });
      }

      const result = await ordersCollection.updateOne(
        {
          _id: new ObjectId(orderId),
          status: order.status,
          assigned_rider_email: req.user.email,
        },
        { $set: updatedDoc },
      );
      if (!result.modifiedCount) {
        await deliveryOtpChallengesCollection.deleteOne({
          _id: challengeId,
          riderEmail: req.user.email,
        });
        return res
          .status(409)
          .send({ message: "This delivery status changed already" });
      }
      await deliveryOtpChallengesCollection.deleteOne({
        _id: challengeId,
        riderEmail: req.user.email,
      });

      if (status === "picked") {
        const notificationForUser = {
          type: "direct",
          email: order.customer.email,
          message: `Your order is picked by the rider.`,
          relatedId: orderId.toString(),
          createdAt: new Date().toISOString(),
          isRead: false,
        };

        await saveNotification(notificationsCollection, notificationForUser);

        const notificationForAdmin = {
          type: "direct",
          email: ADMIN_EMAIL,
          message: `A order is picked by a rider.`,
          relatedId: orderId.toString(),
          createdAt: new Date().toISOString(),
          isRead: false,
        };

        await saveNotification(notificationsCollection, notificationForAdmin);

        const notificationForRider = {
          type: "direct",
          email: req.user.email,
          message: `You picked a order.`,
          relatedId: orderId.toString(),
          createdAt: new Date().toISOString(),
          isRead: false,
        };

        await saveNotification(notificationsCollection, notificationForRider);
      }

      if (status === "delivered") {
        const query = { _id: new ObjectId(order.assigned_rider_id) };
        const rider = await ridersCollection.findOne(query);
        await ridersCollection.updateOne(query, {
          $set: {
            work_status:
              rider?.is_available === false ? "unavailable" : "available",
          },
        });

        const notificationForUser = {
          type: "direct",
          email: order.customer.email,
          message: `Your order is delivered.`,
          relatedId: orderId.toString(),
          createdAt: new Date().toISOString(),
          isRead: false,
        };

        await saveNotification(notificationsCollection, notificationForUser);

        const notificationForAdmin = {
          type: "direct",
          email: ADMIN_EMAIL,
          message: `A order is delivered by a rider.`,
          relatedId: orderId.toString(),
          createdAt: new Date().toISOString(),
          isRead: false,
        };

        await saveNotification(notificationsCollection, notificationForAdmin);

        const notificationForRider = {
          type: "direct",
          email: req.user.email,
          message: `You Delivered a order.`,
          relatedId: orderId.toString(),
          createdAt: new Date().toISOString(),
          isRead: false,
        };

        await saveNotification(notificationsCollection, notificationForRider);
      }
      res.send({ result });
    } catch (error) {
      res.status(500).send({ message: error.message });
    }
  });

  return router;
};