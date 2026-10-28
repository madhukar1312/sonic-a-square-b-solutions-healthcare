import { BlobServiceClient, BlobSASPermissions } from "@azure/storage-blob";
import { randomBytes } from "node:crypto";
import { ApiError } from "@/lib/security/errors";

const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);
const URL_TTL_MS = 5 * 60 * 1000;

function containerClient() {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.MEDICAL_RECORDS_CONTAINER;
  if (!connectionString || !containerName) {
    throw new ApiError(503, "Private document storage is not configured.", "STORAGE_NOT_CONFIGURED");
  }
  return BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
}

export async function createPrivateUploadUrl(prefix: string, contentType: string) {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new ApiError(400, "Only PDF, JPEG, and PNG documents are supported.", "UNSUPPORTED_FILE_TYPE");
  }
  const container = containerClient();
  const properties = await container.getProperties();
  if (properties.blobPublicAccess) {
    throw new ApiError(503, "The configured document container must not allow public access.", "STORAGE_NOT_PRIVATE");
  }
  const objectKey = `${prefix}/${Date.now()}-${randomBytes(18).toString("hex")}`;
  const expiresAt = new Date(Date.now() + URL_TTL_MS);
  const uploadUrl = await container.getBlockBlobClient(objectKey).generateSasUrl({
    permissions: BlobSASPermissions.parse("cw"),
    expiresOn: expiresAt,
  });
  return { objectKey, uploadUrl, expiresAt: expiresAt.toISOString() };
}

export async function verifyPrivateUpload(objectKey: string, contentType: string) {
  const container = containerClient();
  const properties = await container.getProperties();
  if (properties.blobPublicAccess) {
    throw new ApiError(503, "The configured document container must not allow public access.", "STORAGE_NOT_PRIVATE");
  }
  const blob = container.getBlobClient(objectKey);
  const uploaded = await blob.getProperties();
  if (!ALLOWED_CONTENT_TYPES.has(contentType) || uploaded.contentType !== contentType ||
      typeof uploaded.contentLength !== "number" || uploaded.contentLength > 20 * 1024 * 1024) {
    throw new ApiError(400, "Uploaded document type or size is invalid.", "INVALID_DOCUMENT");
  }
}

export async function createPrivateReadUrl(objectKey: string) {
  const container = containerClient();
  const properties = await container.getProperties();
  if (properties.blobPublicAccess) {
    throw new ApiError(503, "The configured document container must not allow public access.", "STORAGE_NOT_PRIVATE");
  }
  const expiresAt = new Date(Date.now() + URL_TTL_MS);
  const url = await container.getBlobClient(objectKey).generateSasUrl({
    permissions: BlobSASPermissions.parse("r"),
    expiresOn: expiresAt,
  });
  return { url, expiresAt: expiresAt.toISOString() };
}
