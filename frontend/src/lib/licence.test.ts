import { describe, expect, it } from "vitest";
import { checkLicenceText } from "./licence";

// Synthetic text shaped like OCR output; no real licence data.
describe("checkLicenceText", () => {
  it("accepts a driving licence with its number", () => {
    expect(checkLicenceText("Indian Union Driving Licence\nIssued by Government of Maharashtra\nMH12 20190001234\nName: TEST DRIVER").ok).toBe(true);
  });
  it("accepts a licence when the number is unreadable but the card fields are", () => {
    expect(checkLicenceText("INDIAN UNION DRIVING LICENSE  Issue Date 01-01-2020 Validity(NT) 01-01-2040").ok).toBe(true);
  });
  it("accepts typical phone-photo misreads", () => {
    expect(checkLicenceText("lndian Unlon Drivlng Licenge\nMHI2 2O19OOO1234\nNAME TEST").ok).toBe(true); // I/l, O for 0, G for C
    expect(checkLicenceText("INDIANUNIONDRIVINGLICENCE ~ Date of Issue 01-01-2020").ok).toBe(true); // words run together
    expect(checkLicenceText("DL No MH-12-2019-0001234  Blood Group O+  Name TEST").ok).toBe(true); // title missed, number and fields read
  });
  it("rejects other documents", () => {
    expect(checkLicenceText("GOVERNMENT OF INDIA  Date of Birth 01/01/1990  1234 5678 9012").ok).toBe(false); // ID card, no licence title
    expect(checkLicenceText("PERMANENT ACCOUNT NUMBER CARD  ABCDE1234F  INCOME TAX DEPARTMENT  Date of Birth 01/01/1990").ok).toBe(false);
    expect(checkLicenceText("Driving licence renewal form, please fill in").ok).toBe(false); // title only
    expect(checkLicenceText("CERTIFICATE OF REGISTRATION  MH12AB1234  Date of Issue 01-01-2020").ok).toBe(false); // vehicle RC
    expect(checkLicenceText("").ok).toBe(false);
  });
});
