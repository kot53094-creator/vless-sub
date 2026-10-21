import pathlib

p = pathlib.Path("src/bot/index.ts")
s = p.read_text(encoding="utf-8")

if "dvb:" in s:
    print("already patched")
    raise SystemExit(0)

s = s.replace(
    '    data.startsWith("dev:") ||',
    '    data.startsWith("dev:") ||\n    data.startsWith("dvb:") ||\n    data.startsWith("dvu:") ||',
)

anchor = '    if (data === "dev:kick") {'
handler = '''    if (data.startsWith("dvb:") || data.startsWith("dvu:")) {
      if (!existing) {
        await answerCallback(env, query.id, "Сначала нажмите /start.", true);
        return;
      }
      const deviceId = Number(data.slice(4));
      const block = data.startsWith("dvb:");
      if (!Number.isFinite(deviceId) || !memRateLimit(`dev:${tgId}`, 12, 60)) {
        await answerCallback(env, query.id, "Не так быстро", true);
        return;
      }
      const done = await setDeviceBlocked(env, existing.id, deviceId, block);
      await answerCallback(
        env,
        query.id,
        done ? (block ? "Устройство отвязано" : "Устройство возвращено") : "Устройство не найдено",
        !done,
      );
      await user.sendDevicesInfo(env, chatId, existing, messageId);
      return;
    }

'''

if anchor not in s:
    raise SystemExit("anchor not found")
s = s.replace(anchor, handler + anchor, 1)

s = s.replace(
    'import { rotateToken } from "../sub";',
    'import { rotateToken, setDeviceBlocked } from "../sub";',
)

p.write_text(s, encoding="utf-8")
print("ok")
