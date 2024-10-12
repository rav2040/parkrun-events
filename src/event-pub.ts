import { get as httpsGet } from "node:https";
import { DynamoDBClient, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { load } from "cheerio";
import Mailjet from "node-mailjet";
import { createEnv } from "@rav2040/dotenv";
import { createLogger } from "./logger.js";

type Parkrunner = {
    id: string;
    position: string;
    name: string;
    time: string;
    event: {
        id: string;
        name: string;
        date: string;
        runNumber: number;
    };
}

export type ParkrunnerNotificationEvent = {
    parkrunnerResult: Parkrunner,
    subscriberAddress: string,
}

const SPOOFED_USER_AGENT = "Mozilla/5.0 (Maemo; Linux armv7l; rv:10.0)";

const Env = createEnv();

const logger = createLogger("event-pub");

const awsClientConfig = {
    region: "ap-southeast-2",
    credentials: {
        accessKeyId: Env.get("AWS_ACCESS_KEY_ID", true),
        secretAccessKey: Env.get("AWS_SECRET_ACCESS_KEY", true),
    }
}

const dynamodb = new DynamoDBClient(awsClientConfig);

const mailjet = new Mailjet.Client({
    apiKey: Env.get("MAILJET_API_KEY_PUBLIC", true),
    apiSecret: Env.get("MAILJET_API_KEY_PRIVATE", true),
});

export async function eventPub() {
    try {
        const t = new Date();
        const currentDate = new Date(t.getFullYear(), t.getMonth(), t.getDate());

        const eventQueryResponse = await dynamodb.send(new ScanCommand({
            TableName: "parkrun-events",
            ExpressionAttributeValues: {
                ":v1": {
                    N: currentDate.valueOf().toString(),
                },
                ":v2": {
                    BOOL: true,
                },
            },
            FilterExpression: "last_modified < :v1 AND is_deleted <> :v2",
            ProjectionExpression: "event_id,display_name,next_run_number",
        }));

        if (!eventQueryResponse.Items) {
            logger.info("No events to scrape");
            return;
        }

        for (const item of eventQueryResponse.Items) {
            const eventId = item["event_id"].S;
            const displayName = item["display_name"].S;
            const nextRunNumber = item["next_run_number"].N;

            if (!eventId || !displayName || !nextRunNumber) {
                continue;
            }

            await scrapeEvent(eventId, displayName, +nextRunNumber);
        }
    } catch (err) {
        logger.error(err as Error);
    }
}

async function scrapeEvent(eventId: string, displayName: string, nextRunNumber: number) {
    const html = await getHtmlString(`https://www.parkrun.co.nz/${eventId}/results/${nextRunNumber}/`);

    const $ = load(html);
    const rows = Array.from($("table.Results-table tbody").find("tr"));

    if (rows.length === 0) {
        logger.info("No new updates found for event '" + eventId + "' (" + nextRunNumber + ")");
        return;
    }

    await dynamodb.send(new UpdateItemCommand({
        TableName: "parkrun-events",
        Key: {
            "event_id": { S: eventId },
        },
        ExpressionAttributeNames: {
            "#N": "next_run_number",
            "#T": "last_modified",
        },
        ExpressionAttributeValues: {
            ":n": {
                N: String(nextRunNumber + 1),
            },
            ":t": {
                N: String(Date.now()),
            },
        },
        UpdateExpression: "SET #N = :n, #T = :t",
    }));

    const eventDate = $("div.Results-header").find("span.format-date").text();

    const parkrunners = rows.map((tr) => {
        const row = $(tr);
        const parkrunnerId = row.find("td[class*=--name]").find("div.compact a").attr("href")?.split("/").at(-1);

        if (!parkrunnerId) {
            return null;
        }

        return {
            id: parkrunnerId,
            position: row.find("td[class*=--position]").text(),
            name: row.find("td[class*=--name]").find("div.compact").text(),
            time: row.find("td[class*=--time]").find("div.compact").text(),
            event: {
                id: eventId,
                name: displayName,
                date: eventDate,
                runNumber: nextRunNumber,
            },
        };
    }).filter((parkrunner): parkrunner is Parkrunner => parkrunner != null);

    const parkrunnerQueryResponse = await dynamodb.send(new ScanCommand({
        TableName: "parkrun-parkrunner-subscriptions",
        ExpressionAttributeValues: {
            ":v1": {
                SS: parkrunners.map(({ id }) => id)
            },
        },
        FilterExpression: "contains(:v1, parkrunner_id)",
        ProjectionExpression: "parkrunner_id,subscriber_address",
    }));

    if (!parkrunnerQueryResponse.Items || parkrunnerQueryResponse.Items.length === 0) {
        logger.info("No subscribers found for any of the parkrunners in event '" + eventId + "' (" + nextRunNumber + ")");
        return;
    }

    const notificationEvents = new Map<string, string[]>();

    for (const item of parkrunnerQueryResponse.Items) {
        const parkrunnerId = item["parkrunner_id"].S;
        const subscriberAddress = item["subscriber_address"].S;

        if (!parkrunnerId || !subscriberAddress) {
            logger.warn("Unable to process parkrunner subscription.");
            continue;
        }

        const existingSubscribers = notificationEvents.get(parkrunnerId) ?? [];

        notificationEvents.set(parkrunnerId, existingSubscribers.concat(subscriberAddress));
    }

    await Promise.allSettled(
        Array.from(notificationEvents).map(async ([parkrunnerId, subscriberAddresses]) => {
            const parkrunnerResult = parkrunners.find((parkrunner) => parkrunner.id === parkrunnerId) || null;

            if (!parkrunnerResult) {
                logger.warn("No parkrunner result found for ID: " + parkrunnerId);
                return;
            }

            const htmlMessage = `
                <p style="font-size:1.5em;">New parkrun result for ${parkrunnerResult.name} (A${parkrunnerResult.id})</p>
                <p style="font-size:1.25em;">
                    <strong>Event:</strong> <a href="https://www.parkrun.co.nz/${parkrunnerResult.event.id}/results/${parkrunnerResult.event.runNumber}/">${parkrunnerResult.event.name} #${parkrunnerResult.event.runNumber}</a><br>
                    <strong>Date:</strong> ${parkrunnerResult.event.date}<br>
                    <strong>Position:</strong> ${parkrunnerResult.position}<br>
                    <strong>Time:</strong> ${parkrunnerResult.time}<br>
                </p>
                <p>
                    To unsubscribe from result notifications for this parkrunner, send an email to unsubscribe@parkrun.rav2040.xyz with the parkrunner ID in the email subject or <a href="mailto:unsubscribe@parkrun.rav2040.xyz?subject=${parkrunnerResult.id}">click here</a>.
                </p>
            `.trim();

            await sendEmail(subscriberAddresses, `New parkrun result for ${parkrunnerResult.name}`, htmlMessage);

            logger.info(`New parkrunnner result published: ${JSON.stringify(parkrunnerResult, null, 2)}`);
        })
    );
}

function getHtmlString(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = httpsGet(url, { headers: { "user-agent": SPOOFED_USER_AGENT } }, (res) => {
            const data: string[] = [];
            res.on('data', (chunk: string) => data.push(chunk));
            res.on('end', () => resolve(data.join("")));
        });

        req.on('error', reject);
    });
}

async function sendEmail(recipients: string[], subject: string, htmlMessage: string) {
    await mailjet
        .post("send", { version: "v3.1" })
        .request({
            Messages: recipients.map((recipient) => ({
                From: {
                    Email: "noreply@parkrun.rav2040.xyz",
                    Name: "Parkrun Notifier",
                },
                To: [{ Email: recipient }],
                Subject: subject,
                HTMLPart: htmlMessage,
            }))
        });
}
