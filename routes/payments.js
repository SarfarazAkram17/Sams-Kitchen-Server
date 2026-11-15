import express from "express";
const router = express.Router();
import { ObjectId } from "mongodb";
import axios from "axios";
import stripe from "../config/stripe.js";
import { ADMIN_EMAIL } from "../config/admin.js";
import verifyJwt from "../middleware/verifyJwt.js";
import { verifyCustomer } from "../middleware/verifyRole.js";
import { saveNotification } from "../services/notifications.js";

const API_URL = "https://sams-kitchen.vercel.app";
const CLIENT_ORDERS_URL = "https://sams-kitchen.netlify.app/dashboard/myOrders";

export default (
  ordersCollection,
  paymentsCollection,
  notificationsCollection,
) => {
  // Every amount below comes from the saved order. Nothing about the price, the
  // payment method or the customer is taken from the request.

  // The order a customer can still pay for: theirs, unpaid and not cancelled.
  const findPayableOrder = async (orderId, email) => {
    if (!ObjectId.isValid(String(orderId || ""))) return null;
    return ordersCollection.findOne({
      _id: new ObjectId(orderId),
      "customer.email": email,
      payment_status: { $ne: "paid" },
      status: "pending",
    });
  };

  router.post(
    "/create-ssl-payment",
    verifyJwt,
    verifyCustomer,
    async (req, res) => {
      try {
        const order = await findPayableOrder(req.body?.orderId, req.user.email);
        if (!order) {
          return res.status(404).send({ message: "Payable order not found" });
        }
        if (!(order.total > 0)) {
          return res
            .status(400)
            .send({ message: "This order has nothing to pay." });
        }

        const tran_id = new ObjectId().toString();
        const name =
          `${order.customer.firstName} ${order.customer.lastName}`.trim();
        const address = order.customer.address;

        const initiate = {
          store_id: process.env.STORE_ID,
          store_passwd: process.env.STORE_PASSWORD,
          total_amount: Math.round(order.total),
          currency: "BDT",
          tran_id,
          success_url: `${API_URL}/payments/success-payment`,
          fail_url: `${API_URL}/payments/fail-payment`,
          cancel_url: `${API_URL}/payments/cancel-payment`,
          ipn_url: `${API_URL}/payments/ipn-success-payment`,
          shipping_method: "Courier",
          product_name: "Foods",
          product_category: "Food",
          product_profile: "general",
          cus_name: name,
          cus_email: req.user.email,
          cus_add1: address.district,
          cus_city: address.thana,
          cus_state: address.region,
          cus_country: "Bangladesh",
          cus_phone: order.customer.phone,
          ship_name: name,
          ship_add1: address.district,
          ship_city: address.thana,
          ship_state: address.region,
          ship_postcode: 1000,
          ship_country: "Bangladesh",
        };

        const iniRes = await axios({
          url: "https://sandbox.sslcommerz.com/gwprocess/v4/api.php",
          method: "POST",
          data: initiate,
          headers: { "Content-type": "application/x-www-form-urlencoded" },
        });

        const gatewayUrl = iniRes?.data?.GatewayPageURL;
        if (!gatewayUrl) {
          return res
            .status(502)
            .send({
              message: "The payment gateway did not respond. Please try again.",
            });
        }

        await paymentsCollection.insertOne({
          orderId: order._id.toString(),
          email: req.user.email,
          name,
          amount: Math.round(order.total),
          paymentMethod: "SSL Commerz",
          transactionId: tran_id,
          status: "pending",
          createdAt: new Date().toISOString(),
        });

        res.status(201).send({ gatewayUrl });
      } catch (error) {
        res
          .status(502)
          .send({ message: "Could not start the payment. Please try again." });
      }
    },
  );

  router.post("/success-payment", async (req, res) => {
    try {
      const { tran_id, val_id } = req.body || {};
      if (typeof tran_id !== "string" || typeof val_id !== "string") {
        return res.redirect(CLIENT_ORDERS_URL);
      }

      const query = { transactionId: tran_id };
      const payment = await paymentsCollection.findOne(query);
      if (!payment || !ObjectId.isValid(String(payment.orderId || ""))) {
        return res.status(404).send({ message: "Payment record not found" });
      }
      const orderId = new ObjectId(payment.orderId);
      const order = await ordersCollection.findOne({ _id: orderId });
      if (!order) {
        return res.status(404).send({ message: "Order not found" });
      }

      // Ask SSLCommerz itself whether this payment is real, and make sure it is
      // this transaction, in BDT, for exactly what the order costs.
      const validation = await axios.get(
        "https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php",
        {
          params: {
            val_id,
            store_id: process.env.STORE_ID,
            store_passwd: process.env.STORE_PASSWORD,
          },
        },
      );
      const result = validation?.data;
      const genuine =
        ["VALID", "VALIDATED"].includes(result?.status) &&
        result?.tran_id === payment.transactionId &&
        (!result?.currency_type || result.currency_type === "BDT") &&
        Math.abs(Number(result?.amount) - Math.round(order.total)) < 1 &&
        payment.amount === Math.round(order.total);

      if (!genuine) {
        await paymentsCollection.deleteOne({
          ...query,
          status: { $ne: "payment done" },
        });
        return res.redirect(CLIENT_ORDERS_URL);
      }

      const isFirstSuccessfulPayment = order.payment_status !== "paid";
      if (isFirstSuccessfulPayment) {
        const paidAt = new Date().toISOString();
        const update = await ordersCollection.updateOne(
          { _id: orderId, payment_status: { $ne: "paid" }, status: "pending" },
          { $set: { payment_status: "paid", status: "confirmed", paidAt } },
        );
        if (!update.modifiedCount) {
          return res
            .status(409)
            .send({ message: "Order is no longer payable" });
        }
      }

      await paymentsCollection.updateOne(query, {
        $set: { status: "payment done", paidAt: new Date().toISOString() },
      });

      if (isFirstSuccessfulPayment) {
        const createdAt = new Date().toISOString();
        await Promise.all([
          saveNotification(notificationsCollection, {
            type: "direct",
            email: payment.email,
            message:
              "Your payment is successful. You can view your receipt in My Orders.",
            relatedId: payment.orderId.toString(),
            createdAt,
            isRead: false,
          }),
          saveNotification(notificationsCollection, {
            type: "direct",
            email: ADMIN_EMAIL,
            message:
              "Payment received. The order is confirmed and ready to be prepared.",
            relatedId: payment.orderId.toString(),
            createdAt,
            isRead: false,
          }),
        ]);
      }

      return res.redirect(CLIENT_ORDERS_URL);
    } catch (error) {
      return res.redirect(CLIENT_ORDERS_URL);
    }
  });

  // A failed or cancelled attempt only removes the pending record, never a finished payment.
  const dropPendingPayment = async (req, res) => {
    const tranId = req.body?.tran_id;
    if (typeof tranId === "string") {
      await paymentsCollection.deleteOne({
        transactionId: tranId,
        status: { $ne: "payment done" },
      });
    }
    return res.redirect(CLIENT_ORDERS_URL);
  };
  router.post("/fail-payment", dropPendingPayment);
  router.post("/cancel-payment", dropPendingPayment);

  // The amount to charge is the saved order's total, never a number from the browser.
  router.post(
    "/create-payment-intent",
    verifyJwt,
    verifyCustomer,
    async (req, res) => {
      try {
        const order = await findPayableOrder(req.body?.orderId, req.user.email);
        if (!order) {
          return res.status(404).send({ message: "Payable order not found" });
        }
        if (!(order.total > 0)) {
          return res
            .status(400)
            .send({ message: "This order has nothing to pay." });
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(order.total) * 100,
          currency: "bdt",
          payment_method_types: ["card"],
          metadata: { orderId: order._id.toString(), email: req.user.email },
        });
        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.log(error);
        res
          .status(500)
          .json({ error: "Could not start the payment. Please try again." });
      }
    },
  );

  // Records a card payment. The browser only says which Stripe payment it made;
  // the server asks Stripe whether it really succeeded, for this order and amount.
  router.post("/", verifyJwt, verifyCustomer, async (req, res) => {
    try {
      const { orderId, transactionId } = req.body || {};
      if (
        typeof transactionId !== "string" ||
        !transactionId.startsWith("pi_")
      ) {
        return res.status(400).send({ message: "Invalid payment reference" });
      }

      const order = await findPayableOrder(orderId, req.user.email);
      if (!order) {
        return res
          .status(404)
          .send({ message: "Order not found or already paid" });
      }

      let intent;
      try {
        intent = await stripe.paymentIntents.retrieve(transactionId);
      } catch (stripeError) {
        return res
          .status(400)
          .send({ message: "We could not verify this payment." });
      }

      const expected = Math.round(order.total) * 100;
      const received = intent.amount_received ?? intent.amount;
      const genuine =
        intent.status === "succeeded" &&
        intent.currency === "bdt" &&
        received === expected &&
        intent.metadata?.orderId === order._id.toString() &&
        intent.metadata?.email === req.user.email;
      if (!genuine) {
        return res
          .status(400)
          .send({ message: "We could not verify this payment." });
      }

      if (await paymentsCollection.findOne({ transactionId: intent.id })) {
        return res
          .status(409)
          .send({ message: "This payment has already been recorded." });
      }

      const paidAt = new Date().toISOString();
      const updateResult = await ordersCollection.updateOne(
        {
          _id: order._id,
          "customer.email": req.user.email,
          payment_status: { $ne: "paid" },
          status: "pending",
        },
        { $set: { payment_status: "paid", status: "confirmed", paidAt } },
      );
      if (updateResult.modifiedCount === 0) {
        return res
          .status(404)
          .send({ message: "Order not found or already paid" });
      }

      const paymentResult = await paymentsCollection.insertOne({
        orderId: order._id.toString(),
        email: req.user.email,
        amount: Math.round(order.total),
        paymentMethod: "card",
        transactionId: intent.id,
        paidAt,
        status: "payment done",
      });

      const relatedId = order._id.toString();
      await saveNotification(notificationsCollection, {
        type: "direct",
        email: req.user.email,
        message: `Your payment is successfully done. Go to my orders and you can download your reciept.`,
        relatedId,
        createdAt: paidAt,
        isRead: false,
      });
      await saveNotification(notificationsCollection, {
        type: "direct",
        email: ADMIN_EMAIL,
        message: `Payment received. The order is confirmed and ready to be prepared.`,
        relatedId,
        createdAt: paidAt,
        isRead: false,
      });

      res.status(201).send({
        message: "Payment recorded and parcel marked as paid",
        insertedId: paymentResult.insertedId,
      });
    } catch (error) {
      res.status(500).send({ message: "Failed to record payment" });
    }
  });

  return router;
};