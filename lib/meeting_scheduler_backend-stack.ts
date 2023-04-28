import * as cdk from "aws-cdk-lib";
import { CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import {
  KeyCondition,
  AuthorizationType,
  GraphqlApi,
  MappingTemplate,
  PartitionKey,
  PrimaryKey,
  SchemaFile,
  Values,
} from "aws-cdk-lib/aws-appsync";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  UserPool,
  AccountRecovery,
  UserPoolEmail,
  Mfa,
} from "aws-cdk-lib/aws-cognito";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { EmailIdentity, Identity } from "aws-cdk-lib/aws-ses";
import { Construct } from "constructs";

export class MeetingSchedulerBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new Bucket(this, "MeetingSchedulerBackendBucket");

    const emailIdentity = new EmailIdentity(
      this,
      "MeetingSchedulerBackendEmailIdentity",
      {
        identity: Identity.domain("meetee.io"),
      }
    );

    const appointmentsTable = new Table(
      this,
      "MeetingSchedulerBackendAppointmentsTable",
      {
        partitionKey: {
          name: "userId",
          type: AttributeType.STRING,
        },
        sortKey: {
          name: "startTime",
          type: AttributeType.STRING,
        },
        removalPolicy: RemovalPolicy.DESTROY,
      }
    );

    const profileTable = new Table(
      this,
      "MeetingSchedulerBackendProfileTable",
      {
        partitionKey: {
          name: "userId",
          type: AttributeType.STRING,
        },
        removalPolicy: RemovalPolicy.DESTROY,
      }
    );
    profileTable.addGlobalSecondaryIndex({
      indexName: "usernameIndex",
      partitionKey: {
        name: "username",
        type: AttributeType.STRING,
      },
    });

    const scheduleTable = new Table(
      this,
      "MeetingSchedulerBackendScheduleTable",
      {
        partitionKey: {
          name: "userId",
          type: AttributeType.STRING,
        },
        removalPolicy: RemovalPolicy.DESTROY,
      }
    );
    scheduleTable.addGlobalSecondaryIndex({
      indexName: "usernameIndex",
      partitionKey: {
        name: "username",
        type: AttributeType.STRING,
      },
    });

    const certificate = Certificate.fromCertificateArn(
      this,
      "certificate",
      "arn:aws:acm:us-east-1:302577123867:certificate/451f2e1b-8f33-4b70-bcbc-8bb0eab3d945"
    );

    const userPool = new UserPool(this, "MeetingSchedulerBackendUserPool", {
      userPoolName: "MeetingSchedulerBackendUserPool",
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      signInAliases: {
        email: true,
      },
      // advancedSecurityMode: AdvancedSecurityMode.
      email: UserPoolEmail.withSES({
        sesRegion: "ap-southeast-2",
        fromEmail: "noreply@meetee.io",
        fromName: "MeeTee",
        sesVerifiedDomain: "meetee.io",
      }),
      autoVerify: {
        email: true,
      },
      mfa: Mfa.REQUIRED,
      mfaSecondFactor: {
        otp: true,
        sms: true,
      },
      selfSignUpEnabled: true,
      signInCaseSensitive: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    userPool.node.addDependency(emailIdentity);

    const userPoolClient = userPool.addClient(
      "MeetingSchedulerBackendClient",
      {}
    );

    userPool.addDomain("MeetingSchedulerBackendDomain", {
      customDomain: {
        domainName: "auth.meetee.io",
        certificate,
      },
    });

    // const certificate = new Certificate(
    //   this,
    //   "MeetingSchedulerBackendCertificate",
    //   {
    //     domainName: "api.meetee.io",
    //     validation: CertificateValidation.fromDns(),

    //   }
    // );

    const api = new GraphqlApi(this, "MeetingSchedulerBackendApi", {
      name: "MeetingSchedulerBackendApi",
      schema: SchemaFile.fromAsset("schema/schema.graphql"),
      domainName: {
        certificate,
        domainName: "api.meetee.io",
      },
      xrayEnabled: true,
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: AuthorizationType.USER_POOL,
          userPoolConfig: { userPool },
        },
      },
    });

    const getAvailableAppointmentsLambda = new NodejsFunction(
      this,
      "getAvailableAppointmentsLambda",
      {
        entry: "src/lambda/getAvailableAppointments.ts",
        environment: {
          SCHEDULE_TABLE_NAME: scheduleTable.tableName,
          APPOINTMENTS_TABLE_NAME: appointmentsTable.tableName,
        },
        timeout: Duration.seconds(30),
      }
    );
    appointmentsTable.grantReadData(getAvailableAppointmentsLambda);
    scheduleTable.grantReadData(getAvailableAppointmentsLambda);
    const ds = api.addLambdaDataSource(
      "getAvailableAppointmentsDataSource",
      getAvailableAppointmentsLambda
    );
    ds.createResolver("getAvailableAppointmentsResolver", {
      fieldName: "getAvailableAppointments",
      typeName: "Query",
    });

    const profileDs = api.addDynamoDbDataSource(
      "profileDataSource",
      profileTable
    );
    profileDs.createResolver("setProfileResolver", {
      fieldName: "setProfile",
      typeName: "Mutation",
      requestMappingTemplate: MappingTemplate.dynamoDbPutItem(
        PrimaryKey.partition("userId").is("userId"),
        Values.projecting("profile")
      ),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    });
    profileDs.createResolver("getProfileResolver", {
      fieldName: "getProfile",
      typeName: "Query",
      requestMappingTemplate: MappingTemplate.dynamoDbGetItem(
        "userId",
        "userId"
      ),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    });
    profileDs.createResolver("getPublicProfileResolver", {
      fieldName: "getPublicProfile",
      typeName: "Query",
      requestMappingTemplate: MappingTemplate.dynamoDbQuery(
        KeyCondition.eq("username", "username"),
        "usernameIndex"
      ),
      responseMappingTemplate: MappingTemplate.fromFile(
        "src/resolvers/getPublicProfile.resp.vtl"
      ),
    });

    const scheduleDs = api.addDynamoDbDataSource(
      "scheduleDataSource",
      scheduleTable
    );
    scheduleDs.createResolver("setScheduleResolver", {
      fieldName: "setSchedule",
      typeName: "Mutation",
      requestMappingTemplate: MappingTemplate.dynamoDbPutItem(
        PrimaryKey.partition("userId").is("userId"),
        Values.projecting("schedule")
      ),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    });
    scheduleDs.createResolver("getScheduleResolver", {
      fieldName: "getSchedule",
      typeName: "Query",
      requestMappingTemplate: MappingTemplate.fromFile(
        "src/resolvers/getSchedule.req.vtl"
      ),
      responseMappingTemplate: MappingTemplate.fromFile(
        "src/resolvers/getSchedule.resp.vtl"
      ),
    });

    const appointmentsDs = api.addDynamoDbDataSource(
      "appointmentsDataSource",
      appointmentsTable
    );
    appointmentsDs.createResolver("setAppointmentResolver", {
      fieldName: "makeAppointment",
      typeName: "Mutation",
      requestMappingTemplate: MappingTemplate.dynamoDbPutItem(
        PartitionKey.partition("userId")
          .is("userId")
          .sort("startTime")
          .is("startTime"),
        Values.projecting()
      ),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    });

    const presignerLambda = new NodejsFunction(this, "presignerLambda", {
      entry: "src/lambda/getPresignUploadUrl.ts",
      environment: {
        BUCKET_NAME: bucket.bucketName,
      },
      timeout: Duration.seconds(30),
    });
    bucket.grantReadWrite(presignerLambda);
    const presignerDS = api.addLambdaDataSource(
      "presignerDataSource",
      presignerLambda
    );
    presignerDS.createResolver("presignerUploadResolver", {
      fieldName: "getPresignUploadUrl",
      typeName: "Query",
    });
    presignerDS.createResolver("presignerDownloadResolver", {
      fieldName: "getPresignDownloadUrl",
      typeName: "Query",
    });

    new CfnOutput(this, "GraphQLAPIURL", {
      value: api.graphqlUrl,
    });
    new CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
    });
    new CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
  }
}
