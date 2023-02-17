import * as cdk from "aws-cdk-lib";
import { CfnOutput } from "aws-cdk-lib";
import {
  AuthorizationType,
  GraphqlApi,
  SchemaFile,
} from "aws-cdk-lib/aws-appsync";
import {
  Certificate,
  CertificateValidation,
  ValidationMethod,
} from "aws-cdk-lib/aws-certificatemanager";
import {
  UserPool,
  AccountRecovery,
  UserPoolEmail,
  Mfa,
} from "aws-cdk-lib/aws-cognito";
import { EmailIdentity, Identity } from "aws-cdk-lib/aws-ses";
import { Construct } from "constructs";

export class MeetingSchedulerBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const emailIdentity = new EmailIdentity(
      this,
      "MeetingSchedulerBackendEmailIdentity",
      {
        identity: Identity.domain("meetee.io"),
      }
    );

    const userPool = new UserPool(this, "MeetingSchedulerBackendUserPool", {
      userPoolName: "MeetingSchedulerBackendUserPool",
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      // advancedSecurityMode: AdvancedSecurityMode.
      email: UserPoolEmail.withSES({
        sesRegion: "ap-southeast-2",
        fromEmail: "noreply@meetee.io",
        fromName: "MeeTee",
        sesVerifiedDomain: "meetee.io",
      }),
      mfa: Mfa.REQUIRED,
      mfaSecondFactor: {
        otp: true,
        sms: true,
      },
      selfSignUpEnabled: true,
      signInCaseSensitive: false,
    });

    userPool.node.addDependency(emailIdentity);

    const userPoolClient = userPool.addClient(
      "MeetingSchedulerBackendClient",
      {}
    );

    // const certificate = new Certificate(
    //   this,
    //   "MeetingSchedulerBackendCertificate",
    //   {
    //     domainName: "api.meetee.io",
    //     validation: CertificateValidation.fromDns(),

    //   }
    // );

    const certificate = Certificate.fromCertificateArn(
      this,
      "certificate",
      "arn:aws:acm:us-east-1:302577123867:certificate/68460b5e-fc65-4136-ae49-02b84a5893c6"
    );

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
