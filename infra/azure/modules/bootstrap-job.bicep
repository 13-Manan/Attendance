// ATTENDANCE PROJECT — production bootstrap runner (Container Apps Job)
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
// A freshly migrated database has tables and no rows. Two sets of rows have to
// exist before anyone can sign in:
//
//   Stage A  the platform Role records and their RolePermission grants. These
//            are data, not schema — no migration inserts them — and the
//            migration image deliberately does not carry the seed that does.
//   Stage B  the first Institution, its administrator User, and the
//            UserRoleAssignment joining them. Every other user in the system is
//            created by an authenticated administrator, so the first one cannot
//            be: it has no administrator to create it.
//
// Both stages need a database that is unreachable from outside the VNet
// (modules/postgres.bicep — no public endpoint, no firewall rule). The same
// reasoning that put the migration inside the network applies here, with more
// force: this job writes the credential the platform's first administrator
// signs in with, and the alternative is opening the production biometric
// database to the internet to do it. See modules/migration-job.bicep for the
// longer version of that argument.
//
// ---------------------------------------------------------------------------
// Why this is a second job and not a second command on the migration job
// ---------------------------------------------------------------------------
// The migration job is started by the deployment pipeline on every deploy. If
// bootstrapping were a command on that job, the image the pipeline runs
// unattended would also contain the code that writes an Institution and an
// administrator password hash — separated from doing so only by which
// arguments a caller happened to pass. Two jobs, two images, two identities,
// two separate approvals. This one has no place in any pipeline.
//
// ---------------------------------------------------------------------------
// Failure behaviour
// ---------------------------------------------------------------------------
// replicaRetryLimit is 0. Both stages take a transaction-scoped advisory lock
// and are individually idempotent, so a retry would not corrupt anything — but
// an automatic retry of a bootstrap that failed halfway is a thing nobody asked
// for, and the useful signal is the first failure's logs. It stops and waits.
//
// triggerType is Manual. Creating this job does not run it. Nothing in
// deploy.yml starts it, and nothing should.
//
// ---------------------------------------------------------------------------
// What runs, and what this template deliberately does not decide
// ---------------------------------------------------------------------------
// The image's ENTRYPOINT is the interpreter and the bootstrap script
// (apps/web/Dockerfile.bootstrap). The STAGE is not set here: it arrives as an
// execution-scoped `--args`, so the job's resting definition names no stage and
// a start with no arguments runs a script that refuses and exits non-zero.
//
// The same is true of the confirmation and the administrator's details. This
// template carries the two values that are constant for every execution —
// which database, and that the database is production — and nothing else.
//
// IMPORTANT, and verified against the CLI source rather than assumed
// (azure/cli/command_modules/containerapp/custom.py, start_containerappsjob):
// `az containerapp job start --env-vars` builds a fresh container override and
// assigns the parsed list to `env` wholesale. It does NOT merge with the env
// declared below. So any execution that passes --env-vars must re-supply every
// variable it needs, including DATABASE_URL=secretref:database-url. The
// runbook spells the full invocation out; this is the reason it looks
// repetitive.

@description('Azure region.')
param location string

@description('Resource name prefix, e.g. attendance-prod.')
param namePrefix string

@description('Container Apps managed environment — the same one the apps use.')
param environmentId string

@description('ACR login server, e.g. attendanceprodacr.azurecr.io.')
param acrLoginServer string

@description('Key Vault URI used for the DATABASE_URL secret reference.')
param keyVaultUri string

@description('''Bootstrap image, tagged by commit — never `latest`. The default
is a placeholder and is harmless because the trigger is manual: an un-run job
runs nothing, whatever it is pointed at.''')
param bootstrapImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('''Pass 2 switch — see modules/app.bicep header. A Key Vault
secret reference is resolved by the platform at create/update time using the
job's own managed identity, which does not exist until the job does. So the
first pass creates the job and its identity, the identity is granted access,
and the second pass turns the reference on.''')
param enableKeyVaultSecretRefs bool = false

@description('''Seconds before a replica is killed. Shorter than the migration
job's: the longest thing this does is one scrypt hash and a handful of inserts
inside a single transaction. A bootstrap still running after 15 minutes is
stuck holding an advisory lock, and killing it is the right outcome.''')
param replicaTimeoutSeconds int = 900

param tags object

var jobName = '${namePrefix}-bootstrap'

// The database URL is never a template literal, an output, or an environment
// value in this file. The platform fetches it from Key Vault at deploy time
// using the job's system-assigned identity and mounts it as a job secret; the
// only thing written down anywhere is the name of the secret.
var jobSecrets = enableKeyVaultSecretRefs ? [
  {
    name: 'database-url'
    keyVaultUrl: '${keyVaultUri}secrets/DATABASE-URL'
    identity: 'system'
  }
] : []

// BOOTSTRAP_TARGET is declared, never inferred — the script refuses to guess
// which database it is pointed at from the shape of the URL. This job only
// ever addresses production, so the value belongs in the definition where it
// can be read by anyone inspecting the job. What is NOT here: BOOTSTRAP_CONFIRM
// (the operator supplies it per execution, which is the point of it) and the
// administrator's name, email and password.
var jobSecretEnv = enableKeyVaultSecretRefs ? [
  {
    name: 'DATABASE_URL'
    secretRef: 'database-url'
  }
  {
    name: 'BOOTSTRAP_TARGET'
    value: 'production'
  }
] : []

resource bootstrapJob 'Microsoft.App/jobs@2024-03-01' = {
  name: jobName
  location: location
  tags: tags
  // Its own identity. Not the web app's, not face-ai's, not the migration
  // job's — so the access this job needs can be granted to this job, and
  // revoking it later cannot break anything else.
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      // Manual, never Schedule and never Event. Nothing starts this but a
      // person, deliberately, once.
      triggerType: 'Manual'
      replicaTimeout: replicaTimeoutSeconds
      // Zero. See header.
      replicaRetryLimit: 0
      manualTriggerConfig: {
        // One replica. Two concurrent bootstraps would serialise on the
        // advisory lock and the loser would time out holding nothing useful.
        parallelism: 1
        replicaCompletionCount: 1
      }
      secrets: jobSecrets
      registries: enableKeyVaultSecretRefs ? [
        {
          server: acrLoginServer
          identity: 'system'
        }
      ] : []
    }
    template: {
      containers: [
        {
          name: 'bootstrap'
          image: bootstrapImage
          resources: {
            // scrypt at N=16384, r=8 needs ~16 MiB; the rest is Node and the
            // Prisma query engine. 0.5/1.0Gi matches the migration job and is
            // the smallest valid Consumption combination above 0.25/0.5Gi.
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          // No command and no args. The image's ENTRYPOINT is the script; the
          // stage is supplied per execution. A job whose definition names no
          // stage cannot be started into one by accident.
          env: jobSecretEnv
        }
      ]
    }
  }
}

// Container Apps Jobs have no ingress at all — there is no ingress block to
// omit, no FQDN, and nothing listening. The job reaches the database and the
// registry outbound through the environment's subnet and is not reachable from
// anywhere, including the rest of the VNet.

output jobName string = bootstrapJob.name
output jobId string = bootstrapJob.id
output principalId string = bootstrapJob.identity.principalId
