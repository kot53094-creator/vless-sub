import { describe, expect, it } from "vitest";
import { buildAutoConfig } from "../src/xray_json";

const LINK =
  "vless://11111111-1111-1111-1111-111111111111@example.com:443?encryption=none&security=reality&sni=example.com&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=ab12&type=tcp&fp=chrome#%F0%9F%87%B7%F0%9F%87%BA%20%D0%A0%D0%BE%D1%81%D1%81%D0%B8%D1%8F-1";

describe("auto probes", () => {
  it("перепроверяет узлы раз в минуту", () => {
    const parsed = JSON.parse(buildAutoConfig([LINK], 12));
    // Минута — компромисс: при смене сети старые задержки устаревают сразу,
    // а чаще опрашивать 12 узлов незачем (батарея и трафик).
    expect(parsed.observatory.probeInterval).toBe("60s");
    expect(parsed.burstObservatory.pingConfig.interval).toBe("60s");
    expect(parsed.remarks).toContain("Авто");
    expect(parsed.routing.balancers[0].strategy.type).toBe("leastPing");
  });
});
