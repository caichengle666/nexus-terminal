import { INotificationSender } from "../notification.dispatcher.service";
import { ProcessedNotification } from "../notification.processor.service";
import { GotifyConfig } from "../../types/notification.types";
import { sendGotifyMessage } from "../gotify";

/** Gotify 推送渠道：地址归一化、SSRF 防护与 Token 处理见 ../gotify.ts */
class GotifySenderService implements INotificationSender {
  async send(notification: ProcessedNotification): Promise<void> {
    const config = notification.config as GotifyConfig;
    const result = await sendGotifyMessage(config, {
      title: notification.subject || "Nexus Terminal",
      message: notification.body,
    });
    console.log(`[GotifySender] Successfully sent notification (id: ${result.id ?? "n/a"}).`);
  }
}

const gotifySenderService = new GotifySenderService();
export default gotifySenderService;
