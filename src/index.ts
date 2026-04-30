import { getInput, getBooleanInput, info, debug, setFailed, setOutput } from "@actions/core";
import { existsSync, statSync } from "fs";
import { open } from "fs/promises";
import process from "process";
import path from "path";

import type { Endpoint } from "./api-types";

const apiBase = process.env.NEXUSMODS_API_BASE?.trim() || "https://api.nexusmods.com/v3";

function createApiClient(apiKey: string) {
  return async function fetchWithAuth(
    url: Parameters<typeof fetch>[0],
    options?: Parameters<typeof fetch>[1],
  ): ReturnType<typeof fetch> {
    const headers = {
      "Content-Type": "application/json",
      apikey: apiKey,
      "User-Agent": "Nexus-Mods/upload-action",
      ...options?.headers,
    };

    const init = { headers, ...options };
    debug(`Fetching URL: ${url} with options: ${JSON.stringify(init, null, 2)}`);

    return fetch(`${apiBase}${url}`, init);
  };
}

type ApiClient = ReturnType<typeof createApiClient>;

const DEFAULT_API_RETRY_INTERVAL_MS = 2000;
const DEFAULT_API_RETRY_ATTEMPTS = 6;

function retryDelay(attempt: number, baseDelayMs = DEFAULT_API_RETRY_INTERVAL_MS): number {
  return Math.min(baseDelayMs * Math.pow(1.5, attempt), 30000);
}

function shouldRetryApiResponse(response: Response): boolean {
  return response.status >= 500;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type CreateMultipartUploadEndpoint = Endpoint<"/uploads/multipart", "post", 201>;

async function createMultipartUpload(
  params: CreateMultipartUploadEndpoint["body"],
  api: ApiClient,
): Promise<CreateMultipartUploadEndpoint["response"]> {
  const { filename, size_bytes } = params;
  const url = `/uploads/multipart`;

  info(`Requesting multipart upload from: ${url}`);

  for (let attempt = 0; attempt < DEFAULT_API_RETRY_ATTEMPTS; attempt++) {
    const response = await api(url, {
      method: "POST",
      body: JSON.stringify({
        filename: path.basename(filename),
        size_bytes: String(size_bytes),
      }),
    });

    if (response.ok) {
      return (await response.json()) as CreateMultipartUploadEndpoint["response"];
    }

    const body = await response.text();

    if (shouldRetryApiResponse(response) && attempt < DEFAULT_API_RETRY_ATTEMPTS - 1) {
      const delay = retryDelay(attempt);
      info(
        `Failed to create multipart upload: ${response.status} - ${body || "<empty response>"}; retrying in ${delay}ms`,
      );
      await sleep(delay);
      continue;
    }

    throw new Error(`Failed to create multipart upload: ${response.status} - ${body}`);
  }

  throw new Error("Failed to create multipart upload: retry attempts exhausted");
}

interface PartUploadResult {
  partNumber: number;
  etag: string;
}

async function uploadPart(
  fileHandle: Awaited<ReturnType<typeof open>>,
  partUrl: string,
  partNumber: number,
  totalParts: number,
  partSize: number,
): Promise<PartUploadResult> {
  const buffer = Buffer.alloc(partSize);
  const offset = (partNumber - 1) * partSize;
  const { bytesRead } = await fileHandle.read(buffer, 0, partSize, offset);

  const partData = bytesRead < partSize ? buffer.subarray(0, bytesRead) : buffer;

  info(`Uploading part ${partNumber}/${totalParts} (${bytesRead} bytes)`);

  const response = await fetch(partUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytesRead),
    },
    body: partData,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload part ${partNumber}: ${response.status} ${await response.text()}`);
  }

  const etag = response.headers.get("ETag");
  if (!etag) {
    throw new Error(`No ETag returned for part ${partNumber}`);
  }

  return { partNumber, etag: etag.replace(/"/g, "") };
}

const DEFAULT_CONCURRENCY = 6;

async function uploadParts(
  filePath: string,
  partUrls: string[],
  partSize: number,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<PartUploadResult[]> {
  const fileHandle = await open(filePath, "r");
  const results: PartUploadResult[] = [];
  const totalParts = partUrls.length;

  try {
    // Process parts in batches for controlled concurrency
    for (let i = 0; i < totalParts; i += concurrency) {
      const batch = partUrls.slice(i, i + concurrency);
      const batchPromises = batch.map((url, batchIndex) => {
        const partNumber = i + batchIndex + 1;
        return uploadPart(fileHandle, url, partNumber, totalParts, partSize);
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }
  } finally {
    await fileHandle.close();
  }

  return results;
}

function buildCompleteMultipartXml(parts: PartUploadResult[]): string {
  const partElements = parts
    .map((p) => `  <Part>\n    <PartNumber>${p.partNumber}</PartNumber>\n    <ETag>${p.etag}</ETag>\n  </Part>`)
    .join("\n");
  return `<CompleteMultipartUpload>\n${partElements}\n</CompleteMultipartUpload>`;
}

async function completeMultipartUpload(completeUrl: string, parts: PartUploadResult[]): Promise<void> {
  const xml = buildCompleteMultipartXml(parts);
  debug(`Completing multipart upload with XML:\n${xml}`);

  const response = await fetch(completeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml",
    },
    body: xml,
  });

  if (!response.ok) {
    throw new Error(`Failed to complete multipart upload: ${response.status} ${await response.text()}`);
  }
}

type FinaliseUploadEndpoint = Endpoint<"/uploads/{id}/finalise", "post">;

async function finaliseUpload(
  params: FinaliseUploadEndpoint["params"],
  api: ApiClient,
): Promise<FinaliseUploadEndpoint["response"]> {
  const { id } = params;
  const url = `/uploads/${id}/finalise`;
  info(`Finalising upload at: ${url}`);

  for (let attempt = 0; attempt < DEFAULT_API_RETRY_ATTEMPTS; attempt++) {
    const response = await api(url, {
      method: "POST",
    });

    if (response.ok) {
      return (await response.json()) as FinaliseUploadEndpoint["response"];
    }

    const body = await response.text();

    if (shouldRetryApiResponse(response) && attempt < DEFAULT_API_RETRY_ATTEMPTS - 1) {
      const delay = retryDelay(attempt);
      info(`Failed to finalise upload: ${response.status} - ${body || "<empty response>"}; retrying in ${delay}ms`);
      await sleep(delay);
      continue;
    }

    throw new Error(`Failed to finalise upload: ${response.status} - ${body}`);
  }

  throw new Error("Failed to finalise upload: retry attempts exhausted");
}

type GetUploadEndpoint = Endpoint<"/uploads/{id}">;

async function pollUploadState(
  params: GetUploadEndpoint["params"],
  api: ApiClient,
  pollIntervalMs = 2000,
  maxAttempts = 60,
): Promise<GetUploadEndpoint["response"]> {
  const { id } = params;
  const url = `/uploads/${id}`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const delay = retryDelay(attempt, pollIntervalMs);
    const response = await api(url, {
      method: "GET",
    });

    if (!response.ok) {
      const body = await response.text();

      if (response.status >= 500) {
        info(`Failed to get upload state: ${response.status} - ${body || "<empty response>"}; retrying`);
        await sleep(delay);
        continue;
      }

      throw new Error(`Failed to get upload state: ${response.status} - ${body}`);
    }

    const { data } = (await response.json()) as GetUploadEndpoint["response"];
    info(`Polling upload ${id}: state = ${data.state}`);

    if (data.state === "available") {
      return { data };
    }

    await sleep(delay);
  }

  throw new Error(`Upload processing timed out after ${maxAttempts} attempts for ${id}`);
}

type UpdateModFileEndpoint = Endpoint<"/mod-file-update-groups/{group_id}/versions", "post", 201>;

async function updateModFile(
  params: UpdateModFileEndpoint["params"] & UpdateModFileEndpoint["body"],
  api: ApiClient,
): Promise<UpdateModFileEndpoint["response"]> {
  const { group_id, ...body } = params;
  const url = `/mod-file-update-groups/${group_id}/versions`;
  info(`Updating mod file at: ${url}`);

  const response = await api(url, {
    method: "POST",
    body: JSON.stringify(body satisfies UpdateModFileEndpoint["body"]),
  });

  if (!response.ok) {
    throw new Error(`Failed to update Mod file: ${response.status} - ${await response.text()}`);
  }

  return (await response.json()) as UpdateModFileEndpoint["response"];
}

function getOptionalBooleanInput(name: string): boolean | undefined {
  const value = getInput(name);
  if (value === "") return undefined;
  return getBooleanInput(name);
}

export async function run(): Promise<void> {
  info("Starting NexusMods upload action");

  try {
    const apiKey = getInput("api_key", { required: true });
    const api = createApiClient(apiKey);

    const groupId = getInput("file_group_id", { required: true });
    const filename = getInput("filename", { required: true });
    const version = getInput("version", { required: true });
    const name = getInput("display_name") || path.basename(filename);
    const description = getInput("description") || undefined;
    const fileCategory = (getInput("file_category") || "main") as UpdateModFileEndpoint["body"]["file_category"];
    const archiveExistingFile = getBooleanInput("archive_existing_file");
    const primaryModManagerDownload = getOptionalBooleanInput("primary_mod_manager_download");
    const allowModManagerDownload = getOptionalBooleanInput("allow_mod_manager_download");
    const showRequirementsPopup = getOptionalBooleanInput("show_requirements_pop_up");

    if (!existsSync(filename)) {
      throw new Error(`File not found: ${filename}`);
    }
    const { size: fileSize } = statSync(filename);

    // Step 1: Create multipart upload
    const {
      data: { id: uploadId, part_presigned_urls, part_size_bytes, complete_presigned_url },
    } = await createMultipartUpload({ size_bytes: fileSize, filename }, api);
    info(`Created multipart upload: ${uploadId} (${part_presigned_urls.length} parts, ${part_size_bytes} bytes each)`);

    // Step 2: Upload all parts
    const parts = await uploadParts(filename, part_presigned_urls, part_size_bytes);
    info(`Uploaded ${parts.length} parts successfully`);

    // Step 3: Complete multipart upload
    await completeMultipartUpload(complete_presigned_url, parts);
    info("Multipart upload completed");

    // Step 4: Finalise upload
    const { data: finaliseResult } = await finaliseUpload({ id: uploadId }, api);
    info(`Finalised upload: ${finaliseResult.id} (state: ${finaliseResult.state})`);

    // Step 5: Poll until upload is available
    await pollUploadState({ id: uploadId }, api);
    info("Upload is now available");

    // Step 6: Update file (associate with mod)
    const {
      data: { id: newFileId },
    } = await updateModFile(
      {
        group_id: groupId,
        upload_id: uploadId,
        name,
        description,
        version,
        file_category: fileCategory,
        archive_existing_file: archiveExistingFile,
        primary_mod_manager_download: primaryModManagerDownload,
        allow_mod_manager_download: allowModManagerDownload,
        show_requirements_pop_up: showRequirementsPopup,
      },
      api,
    );
    setOutput("file_uid", newFileId);
    info("File updated successfully");

    info("File uploaded successfully to NexusMods.");
  } catch (error) {
    if (error instanceof Error) {
      setFailed(error.message);
    } else {
      setFailed(String(error));
    }
  }
}
