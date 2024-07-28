import { get as httpsGet } from "node:https";
import { join } from "node:path";
import { DynamoDBClient, ScanCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { createEnv } from "@rav2040/dotenv";
import { createLogger } from "./logger.js";

const SPOOFED_USER_AGENT = "Mozilla/5.0 (Maemo; Linux armv7l; rv:10.0)";

const logger = createLogger("event-sync");

const Env = createEnv({ path: join(__dirname, "../.env") });

const awsClientConfig = {
    region: "ap-southeast-2",
    credentials: {
        accessKeyId: Env.get("AWS_ACCESS_KEY_ID", true),
        secretAccessKey: Env.get("AWS_SECRET_ACCESS_KEY", true),
    }
}

const dynamodb = new DynamoDBClient(awsClientConfig);

async function main() {
    try {
        const eventQueryResponse = await dynamodb.send(new ScanCommand({ TableName: "parkrun-events" }));

        const json = await getHttpResponseBody("https://images.parkrun.com/events.json");
        const o = JSON.parse(json);

        const countrycode = Object.entries(o.countries).find(([_, entry]: any) => entry.url?.endsWith(".nz"))?.[0];

        if (!countrycode) {
            logger.error("NZ country code not found.");
            return;
        }

        const events: Array<{ id: string; displayName: string }> = o.events.features
            .filter(({ properties }: any) => properties.countrycode === Number(countrycode))
            .map(({ properties }: any) => ({ id: properties.eventname, displayName: properties.EventShortName }));

        if (events.length === 0) {
            logger.error("No events found.");
            return;
        }

        logger.info(`Found ${events.length} events...`);

        for (const event of events) {
            if (eventQueryResponse.Items?.some((item) => item["event_id"].S === event.id)) {
                logger.info(`Event '${event.id}' is already known... skipping.`);
                continue;
            }

            await dynamodb.send(new PutItemCommand({
                TableName: "parkrun-events",
                Item: {
                    "event_id": { S: event.id },
                    "display_name": { S: event.displayName },
                    "next_run_number": { N: "1" },
                    "last_modified": { N: "0" },
                },
            }));

            logger.info(`NEW event '${event.id}' has been successfully added.`);
        }
    } catch (err) {
        logger.error(err);
    }
}

function getHttpResponseBody(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = httpsGet(url, { headers: { "user-agent": SPOOFED_USER_AGENT } }, (res) => {
            const data: string[] = [];
            res.on('data', (chunk: string) => data.push(chunk));
            res.on('end', () => resolve(data.join("")));
        });

        req.on('error', reject);
    });
}

main();
