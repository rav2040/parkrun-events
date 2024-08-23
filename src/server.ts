import { createServer } from 'node:http';
import { CronJob } from 'cron';
import { createEnv } from '@rav2040/dotenv';
import { subscriptionHandler, type MailjetBody } from './subscription-handler.js';
import { eventPub } from './event-pub.js';
import { eventSync } from './event-sync.js';
import { createLogger } from "./logger.js";
import cronSchedule from "../cron-schedule.json";

const Env = createEnv();

const timezone = Env.get("TZ", true);

const logger = createLogger("server");

const eventPubStandardJob = CronJob.from({
  cronTime: cronSchedule.eventPubStandardJob,
  onTick: eventPub,
  start: false,
  timeZone: timezone,
});

const eventPubChristmasJob = CronJob.from({
  cronTime: cronSchedule.eventPubChristmasJob,
  onTick: eventPub,
  start: false,
  timeZone: timezone,
});

const eventPubNewYearJob = CronJob.from({
  cronTime: cronSchedule.eventPubNewYearJob,
  onTick: eventPub,
  start: false,
  timeZone: timezone,
});

const eventSyncJob = CronJob.from({
  cronTime: cronSchedule.eventSyncJob,
  onTick: eventSync,
  start: false,
  timeZone: timezone,
});


createServer((request, response) => {
    request.on('error', err => {
      logger.error(err);

      response.statusCode = 400;
      response.end();
    });

    response.on('error', err => {
      logger.error(err);
    });

    const body: Uint8Array[] = [];
    request
      .on('data', chunk => {
        body.push(chunk);
      })
      .on('end', () => {
        const mailjetBody: MailjetBody = JSON.parse(Buffer.concat(body).toString());

        subscriptionHandler(mailjetBody).then(() => {
          response.statusCode = 200;
          response.end();
        });
      });
  })
  .listen(3000, () => {
    logger.info("Server is listenting on port 3000.");
  });

eventPubStandardJob.start();
eventPubChristmasJob.start();
eventPubNewYearJob.start();
eventSyncJob.start();

logger.info("Cron jobs have started.");
