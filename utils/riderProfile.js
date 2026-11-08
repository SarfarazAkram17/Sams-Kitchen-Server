const PHONE_PATTERN = /^(?:\+?88)?01[3-9]\d{8}$/;

export const text = (value) => (typeof value === "string" ? value.trim() : "");

// The delivery details a rider gives when applying (and when applying again).
export const parseRiderProfile = (input) => {
  const phone = text(input?.phone);
  const age = Number.parseInt(input?.age, 10);
  const experience = Number.parseInt(input?.experience, 10);
  const region = text(input?.region);
  const district = text(input?.district);
  const thana = text(input?.thana);

  if (!PHONE_PATTERN.test(phone)) {
    return { error: "Enter a valid Bangladesh mobile number." };
  }
  if (!Number.isInteger(age) || age < 18) {
    return { error: "Riders must be at least 18 years old." };
  }
  if (!Number.isInteger(experience) || experience < 0) {
    return { error: "Experience cannot be negative." };
  }
  if (!region || !district || !thana) {
    return { error: "Choose your region, district and thana." };
  }
  return { profile: { phone, age, experience, region, district, thana } };
};
