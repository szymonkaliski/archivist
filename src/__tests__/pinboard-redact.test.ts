import { describe, it, expect } from "vitest";
import { redactToken } from "../sources/pinboard/index";

// shaped like a real token (username + ":" + 20 hex) but not one
const SECRET = "0000AAAA1111BBBB2222";
const TOKEN = `testuser%3A${SECRET}`;

// the three failure shapes node-fetch has actually produced for posts/all
const MESSAGES = [
  `invalid json response body at https://api.pinboard.in/v1/posts/all?auth_token=${TOKEN}&format=json reason: Unexpected token 'A', "An interna"... is not valid JSON`,
  `request to https://api.pinboard.in/v1/posts/all?auth_token=${TOKEN}&format=json failed, reason: connect ETIMEDOUT`,
  `Invalid response body while trying to fetch https://api.pinboard.in/v1/posts/all?auth_token=${TOKEN}&format=json: aborted`,
];

describe("redactToken", () => {
  it.each(MESSAGES)("strips the token from %#", (message) => {
    const redacted = redactToken(message);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain("auth_token=[redacted]");
  });

  it("keeps the rest of the message intact", () => {
    expect(redactToken(MESSAGES[1])).toBe(
      "request to https://api.pinboard.in/v1/posts/all?auth_token=[redacted]&format=json failed, reason: connect ETIMEDOUT",
    );
  });

  it("leaves messages without a token untouched", () => {
    expect(redactToken("some other failure")).toBe("some other failure");
  });
});
