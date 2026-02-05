module.exports = {
  /**
   * The port to run Nucleus Server on, if the port is in use the server will not start
   */
  port: 3030,

  /**
   * The fully qualified domain + path that Nucleus is being hosted at
   */
  baseURL: 'http://localhost:8888',

  /**
   * Sequelize connection information, please note all options are required
   *
   * database: The name of the database to connect to
   * dialect: The type of SQL database this is (mysql)
   * username: Username to use when connecting
   * password: Password to use when connecting
   * host: Hostname of database
   * port: Port to use when connecting
   */
  sequelize: {
    dialect: 'mysql',
    database: '',
    username: '',
    password: '',
    host: '',
    port: 3306,
  },

  /**
   * S3 configuration for file storage
   *
   * There is actually no authentication config for s3, all config must be done through the standard AWS
   * environment variables or through EC2 IAM roles.
   *
   * See http://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/setting-credentials-node.html
   */
  s3: {
    // init: {
    //   endpoint: '' // The alternate endpoint to reach the S3 instance at,
    //   s3ForcePathStyle: true // Always use path style URLs
    // }

    bucketName: '', // The name for your S3 Bucket

    cloudfront: { // If you don't have CloudFront set up and just want to use the S3 bucket set this to "null"
      distributionId: '', // The CloudFront distribution ID, used for invalidating files
      publicUrl: '', // Fully qualified URL for the root of the CloudFront proxy for the S3 bucket
    }
  },

  /**
   * GitHub authentication details
   *
   * The `adminIdentifiers` array should be a list of GitHub usernames
   * to consider admins
   *
   * clientID: GitHub API client ID
   * clientSecret: GitHub API clientSecret
   */
  github: {
    clientID: '',
    clientSecret: ''
  },

  /**
   * GitHub usernames to consider admins
   */
  adminIdentifiers: ['admin'],

  /**
   * Session options
   *
   * secret: A secret string used to sign session cookies (CHANGE THIS IN PRODUCTION!)
   */
  sessionConfig: {
    secret: 'ThisIsNotSecret',
  },

  organization: 'My Company Here',

  /**
   * GPG key to use when signing APT and YUM releases
   *
   * Requires to be unlocked (no password) and have both the private and
   * public key.
   */
  gpgSigningKey: 'GPG KEY HERE',

  /**
   * The default percentage rollout for new releases.  The first release for
   * any channel will always be 100% but all future releases will have a
   * default rollout value of this setting
   */
  defaultRollout: 0
};
