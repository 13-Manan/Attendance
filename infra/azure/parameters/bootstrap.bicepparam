// ATTENDANCE PROJECT — bootstrap job parameters
//
// NO SECRETS IN THIS FILE.
//
// Nothing here is confidential: the database URL, the administrator's address
// and the administrator's password are not parameters of this deployment at
// all. The URL is a Key Vault reference resolved by the job's identity; the
// other two are supplied per execution and never written down.

using '../bootstrap.bicep'

param location = 'centralindia'
param namePrefix = 'attendance-prod'

// The resources this template reads. Identical to production.bicepparam, and
// to what main.bicep actually deployed.
param environmentName = 'attendance-prod-cae'
param keyVaultName = 'attendance-prod-keyvault'
param registryName = 'attendanceprodacr'
param databaseUrlSecretName = 'DATABASE-URL'

// Built by `az acr build -r attendanceprodacr -f apps/web/Dockerfile.bootstrap`.
//
// The tag is a commit, not `latest`, so the job definition is a permanent
// record of exactly which code wrote the first rows into production. Pin the
// digest instead of the tag if the tag is ever rebuilt.
//
// It names 0181b518 — the commit of the seven files the image actually
// contains — rather than the later commit that added the Dockerfile. All seven
// are unchanged since then, so the image's contents are identical either way,
// and the useful question afterwards is "which bootstrap code ran", not "which
// build recipe assembled it".
param bootstrapImage = 'attendanceprodacr.azurecr.io/bootstrap:0181b5183d2f4f1e8d3691a70fc3d48458173ac8'

// Pass 1 = false, pass 2 = true. See the parameter's description in
// ../bootstrap.bicep for why it takes two deployments. Override on the command
// line rather than editing this line back and forth:
//
//   az deployment group create ... --parameters enableKeyVaultSecretRefs=true
param enableKeyVaultSecretRefs = false

// Identical to every other Attendance resource, so ownership is never
// ambiguous — particularly relevant here, where `attendance` also appears in
// the name of an unrelated resource group belonging to another project.
param tags = {
  Project: 'Attendance'
  Environment: 'Production'
  ManagedBy: 'Bicep'
  Application: 'Attendance'
  Owner: 'QUBRIX'
  Repository: 'attendance-platform'
}
