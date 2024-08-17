import { DynamoDBClient, PutItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import Mailjet from "node-mailjet";
import { createEnv } from "@rav2040/dotenv";

export type MailjetBody = {
    Sender: string;
    Recipient: string;
    Subject: string;
}

const Env = createEnv();

const mailjet = new Mailjet.Client({
    apiKey: Env.get("MAILJET_API_KEY_PUBLIC", true),
    apiSecret: Env.get("MAILJET_API_KEY_PRIVATE", true),
});

const dynamodb = new DynamoDBClient({});

export async function subscriptionHandler(body: MailjetBody) {
    const command = body.Recipient.slice(0, body.Recipient.indexOf("@")).toLowerCase();
    const parkrunnerIds = body.Subject.split(",").map((str) => str.replace(/[^0-9]/gi, "")).filter(Boolean);

    if (command === "subscribe") {
        await Promise.all(
            parkrunnerIds.map(async (parkrunnerId) => {
                await dynamodb.send(new PutItemCommand({
                    TableName: "parkrun-parkrunner-subscriptions",
                    Item: {
                        "parkrunner_id": { S: parkrunnerId },
                        "subscriber_address": { S: body.Sender },
                    },
                }));
            })
        );

        console.info(`New parkrunner subscriptions successfully added to the database for subscriber '${body.Sender}': ${JSON.stringify(parkrunnerIds, null, 2)}`);

        const htmlMessage = `
            <p style="font-size:1.25em;">
                You have successfully subscribed to parkrun result notifications for the following parkrunners:
            <p>
            <ul style="font-size:1.25em;">
                ${parkrunnerIds.map((parkrunnerId) => `<li><a href="https://www.parkrun.co.nz/parkrunner/${parkrunnerId}/">A${parkrunnerId}</a></li>`).join("")}
            </ul>
            <p>
                To unsubscribe from result notifications for the above parkrunners, send an email to unsubscribe@parkrun.rav2040.xyz with a comma-separated list of the parkrunner IDs in the email subject or <a href="mailto:unsubscribe@parkrun.rav2040.xyz?subject=${parkrunnerIds.toString()}">click here</a>.
            </p>
        `.trim();

        await sendEmail([body.Sender], "Subscription confirmation", htmlMessage);

        return;
    }

    if (command === "unsubscribe") {
        await Promise.all(
            parkrunnerIds.map(async (parkrunnerId) => {
                await dynamodb.send(new DeleteItemCommand({
                    TableName: "parkrun-parkrunner-subscriptions",
                    Key: {
                        "parkrunner_id": { S: parkrunnerId },
                        "subscriber_address": { S: body.Sender },
                    },
                }));
            })
        );

        console.info(`Parkrunner subscriptions have been successfully removed from the database for subscriber '${body.Sender}': ${JSON.stringify(parkrunnerIds, null, 2)}`);

        const htmlMessage = `
            <p style="font-size:1.25em;">
                You have successfully <strong>unsubscribed</strong> from parkrun result notifications for the following parkrunners:
            <p>
            <ul style="font-size:1.25em;">
                ${parkrunnerIds.map((parkrunnerId) => `<li><a href="https://www.parkrun.co.nz/parkrunner/${parkrunnerId}/">A${parkrunnerId}</a></li>`).join("")}
            </ul>
        `.trim();

        await sendEmail([body.Sender], "Subscription confirmation", htmlMessage);

        return;
    }

    console.log(`Command '${command}' is not recognised. Event: ${JSON.stringify(body, null, 2)}`);
}

function sendEmail(recipients: string[], subject: string, htmlMessage: string) {
    return mailjet
        .post("send", { version: "v3.1" })
        .request({
            Messages: [
                {
                    From: {
                        Email: "noreply@parkrun.rav2040.xyz",
                        Name: "Parkrun Notifier",
                    },
                    To: recipients.map((recipient) => ({ Email: recipient })),
                    Subject: subject,
                    HTMLPart: htmlMessage,
                }
            ]
        });
}
