import { AppSyncResolverEvent, Context } from "aws-lambda";
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { DateTime, Interval } from "luxon";

interface Arguments {
  date: string;
  userId: string;
  tz: string;
}

enum DAY {
  SUNDAY = "sunday",
  MONDAY = "monday",
  TUESDAY = "tuesday",
  WEDNESDAY = "wednesday",
  THURSDAY = "thursday",
  FRIDAY = "friday",
  SATURDAY = "saturday",
}

const DAY_OF_WEEK = [
  DAY.SUNDAY,
  DAY.MONDAY,
  DAY.TUESDAY,
  DAY.WEDNESDAY,
  DAY.THURSDAY,
  DAY.FRIDAY,
  DAY.SATURDAY,
];

interface Schedule {
  userId: string;
  days: {
    [key in DAY]: {
      startTime: string;
      endTime: string;
    }[];
  };
}

interface Appointment {
  id: string;
  userId: string;
  startTime: string;
  endTime: string;
}

const client = new DynamoDBClient({});

export async function handler(
  event: AppSyncResolverEvent<Arguments, {}>,
  context: Context
) {
  const timezone = event.arguments.tz;
  const date = event.arguments.date;

  const userId = event.arguments.userId;

  const scheduleResponse = await client.send(
    new GetItemCommand({
      TableName: process.env.SCHEDULE_TABLE_NAME,
      Key: marshall({
        userId: userId,
      }),
    })
  );
  if (!scheduleResponse.Item) {
    throw new Error("No schedule found");
  }
  const schedule = unmarshall(scheduleResponse.Item) as Schedule;

  const appointmentsResponse = await client.send(
    new QueryCommand({
      TableName: process.env.APPOINTMENTS_TABLE_NAME,
      KeyConditionExpression: "userId = :userId and begins_with(#date, :date)",
      ExpressionAttributeNames: {
        "#date": "startTime",
      },
      ExpressionAttributeValues: marshall({
        ":userId": userId,
        ":date": date,
      }),
    })
  );

  if (!appointmentsResponse.Items) {
    throw new Error("No appointments found");
  }
  const appointments = appointmentsResponse.Items.map(
    (item) => unmarshall(item) as Appointment
  );

  const dateTime = DateTime.fromISO(date, { zone: timezone }).startOf("day");
  const dayOfWeek = DAY_OF_WEEK[dateTime.weekday % 7];
  console.log(dayOfWeek, dateTime);

  if (!schedule.days.hasOwnProperty(dayOfWeek)) {
    throw new Error("No schedule found for this day");
  }

  const daySchedule = Object.values(schedule.days[dayOfWeek]).map((timeSlot) =>
    Interval.fromISO(
      `${date}T${timeSlot.startTime}/${date}T${timeSlot.endTime}`
    )
  );

  const appointmentInterval = appointments.map((appointment) =>
    Interval.fromISO(`${appointment.startTime}/${appointment.endTime}`)
  );

  const availableTimes = daySchedule.map((timeSlot) =>
    timeSlot.difference(...appointmentInterval)
  );
  const availableTimesFlat = availableTimes.reduce(
    (acc, val) => acc.concat(val),
    []
  );

  return availableTimesFlat.map((interval) => ({
    startTime: interval.start
      .setZone(timezone)
      .toISO({ suppressMilliseconds: true }),
    endTime: interval.end
      .setZone(timezone)
      .toISO({ suppressMilliseconds: true }),
  }));
}
