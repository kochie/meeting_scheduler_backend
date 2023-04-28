import {
  AppSyncResolverEvent,
  Context,
  AppSyncIdentityCognito,
} from "aws-lambda";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

interface Arguments {
  userId: string;
  key: string;
}

const S3 = new S3Client({});

export async function handler(
  event: AppSyncResolverEvent<Arguments, {}>,
  context: Context
) {
  console.log(event);

  if (
    event.arguments.userId !==
    (event?.identity as AppSyncIdentityCognito).claims.email
  ) {
    throw new Error("Unauthorized");
  }

  let command;

  switch (event.info.fieldName) {
    case "getPresignUploadUrl": {
      command = new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: event.arguments.key,
      });
      break;
    }
    case "getPresignDownloadUrl": {
      command = new GetObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: event.arguments.key,
      });
      break;
    }
    default:
      throw new Error("Invalid field name");
  }

  const url = await getSignedUrl(S3, command, { expiresIn: 60 });

  return url;
}
