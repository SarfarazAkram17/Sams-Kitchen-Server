import "dotenv/config";
import Stripe from "stripe";

const stripe = new Stripe(process.env.PAYMENT_GATEWAY_KEY);

export default stripe;
