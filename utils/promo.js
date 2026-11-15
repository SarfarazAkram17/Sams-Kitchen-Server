// Promo code rules, shared by the promo routes and by order creation so a code
// is judged the same way when a customer previews it and when the order is placed.

export const PROMO_TYPES = ["percent", "fixed"];

const CODE_PATTERN = /^[A-Z0-9_-]{3,20}$/;

export const normalizeCode = (value) =>
  typeof value === "string" ? value.trim().toUpperCase() : "";

export const isValidCode = (code) => CODE_PATTERN.test(code);

const whole = (value) => Math.round(Number(value) || 0);

// "active", "scheduled" (starts later), "expired", "used_up" (limit reached) or "disabled".
export const promoState = (promo, now = new Date()) => {
  if (!promo.active) return "disabled";
  if (promo.startsAt && new Date(promo.startsAt) > now) return "scheduled";
  if (promo.expiresAt && new Date(promo.expiresAt) <= now) return "expired";
  if (promo.usageLimit && (promo.usedCount || 0) >= promo.usageLimit)
    return "used_up";
  return "active";
};

// Whole-taka discount for an amount of food (after food discounts, before delivery).
export const calcDiscount = (promo, amount) => {
  const base = Math.max(0, whole(amount));
  let discount =
    promo.type === "percent"
      ? Math.round((base * promo.value) / 100)
      : whole(promo.value);
  if (promo.type === "percent" && promo.maxDiscount) {
    discount = Math.min(discount, promo.maxDiscount);
  }
  return Math.min(discount, base);
};

const STATE_MESSAGES = {
  disabled: "This promo code is not active.",
  scheduled: "This promo code is not active yet.",
  expired: "This promo code has expired.",
  used_up: "This promo code has reached its usage limit.",
};

// { ok: true, discount } or { ok: false, message }.
export const checkPromo = (promo, amount, now = new Date()) => {
  const state = promoState(promo, now);
  if (state !== "active") return { ok: false, message: STATE_MESSAGES[state] };

  const base = whole(amount);
  if (promo.minOrder && base < promo.minOrder) {
    return {
      ok: false,
      message: `Spend at least \u09F3${promo.minOrder.toLocaleString("en-BD")} on food to use this code.`,
    };
  }

  const discount = calcDiscount(promo, base);
  if (discount <= 0) {
    return {
      ok: false,
      message: "This promo code gives no discount on this order.",
    };
  }
  return { ok: true, discount };
};

// "2026-11-08" at the start or end of that day in Bangladesh time (UTC+6), as an ISO string.
const dayToIso = (day, time) => {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day))
    return undefined;
  const date = new Date(`${day}T${time}+06:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

// Empty or missing means "not set"; anything else must be a whole number.
const optionalWhole = (value) => {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : NaN;
};

// Validates the admin's form. Returns { data } or { error }. The code itself is only
// read when creating; it never changes afterwards, so order history stays readable.
export const parsePromoInput = (body, { creating }) => {
  const data = {};

  if (creating) {
    const code = normalizeCode(body.code);
    if (!isValidCode(code)) {
      return {
        error: "Code must be 3 to 20 letters, numbers, dashes or underscores.",
      };
    }
    data.code = code;
  }

  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  if (description.length > 120) {
    return { error: "Description can be at most 120 characters." };
  }
  data.description = description;

  if (!PROMO_TYPES.includes(body.type)) {
    return { error: "Choose a discount type." };
  }
  data.type = body.type;

  const value = optionalWhole(body.value);
  if (value === null || Number.isNaN(value) || value < 1) {
    return { error: "Enter a discount value of at least 1." };
  }
  if (data.type === "percent" && value > 100) {
    return { error: "A percentage discount cannot be more than 100." };
  }
  data.value = value;

  const minOrder = optionalWhole(body.minOrder);
  if (Number.isNaN(minOrder) || (minOrder !== null && minOrder < 0)) {
    return { error: "Minimum order must be a whole number, 0 or more." };
  }
  data.minOrder = minOrder || 0;

  const maxDiscount = optionalWhole(body.maxDiscount);
  if (Number.isNaN(maxDiscount) || (maxDiscount !== null && maxDiscount < 1)) {
    return { error: "Maximum discount must be a whole number, 1 or more." };
  }
  data.maxDiscount = data.type === "percent" ? maxDiscount : null;

  const usageLimit = optionalWhole(body.usageLimit);
  if (Number.isNaN(usageLimit) || (usageLimit !== null && usageLimit < 1)) {
    return { error: "Total usage limit must be a whole number, 1 or more." };
  }
  data.usageLimit = usageLimit;

  const perUserLimit = optionalWhole(body.perUserLimit);
  if (
    Number.isNaN(perUserLimit) ||
    (perUserLimit !== null && (perUserLimit < 1 || perUserLimit > 100))
  ) {
    return { error: "Uses per customer must be a whole number from 1 to 100." };
  }
  data.perUserLimit = perUserLimit || 1;

  const hasStart =
    body.startsAt !== "" &&
    body.startsAt !== null &&
    body.startsAt !== undefined;
  const hasEnd =
    body.expiresAt !== "" &&
    body.expiresAt !== null &&
    body.expiresAt !== undefined;
  const startsAt = hasStart ? dayToIso(body.startsAt, "00:00:00.000") : null;
  const expiresAt = hasEnd ? dayToIso(body.expiresAt, "23:59:59.999") : null;
  if (startsAt === undefined || expiresAt === undefined) {
    return { error: "Dates must look like 2026-11-08." };
  }
  if (startsAt && expiresAt && expiresAt <= startsAt) {
    return { error: "The end date must be after the start date." };
  }
  data.startsAt = startsAt;
  data.expiresAt = expiresAt;

  data.active = body.active === undefined ? true : Boolean(body.active);

  return { data };
};