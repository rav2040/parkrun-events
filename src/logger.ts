import { createLogger as createWinstonLogger, transports, format } from "winston";

export const createLogger = (appName: string) => {
    return createWinstonLogger({
        format: format.combine(
            format.errors({ stack: true }),
            format.timestamp(),
            format.prettyPrint(),
        ),
        transports: [
            new transports.Console(),
            new transports.File({ filename: appName + ".log", dirname: __dirname, maxsize: 52_428_800 }),
        ],
    });
};
