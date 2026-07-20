import { VfsError } from "../core/errors.js";
import type {
  ByteBody,
  BeginOpaqueUploadOptions,
  CommitOpaqueUploadOptions,
  OpaqueFileStat,
  OpaqueStore,
  OpaqueUploadReservation,
  VirtualFileSystem,
} from "./types.js";

export interface OpaqueUploadCoordinator {
  beginOpaqueUpload(
    path: string,
    options?: BeginOpaqueUploadOptions,
  ): Promise<OpaqueUploadReservation> | OpaqueUploadReservation;
  commitOpaqueUpload(
    uploadId: string,
    options?: CommitOpaqueUploadOptions,
  ): Promise<OpaqueFileStat>;
  abortOpaqueUpload(uploadId: string): Promise<void> | void;
}

export async function putOpaque(
  coordinator: OpaqueUploadCoordinator,
  store: OpaqueStore,
  path: string,
  body: ByteBody,
  options: BeginOpaqueUploadOptions & CommitOpaqueUploadOptions = {},
): Promise<OpaqueFileStat> {
  const reservation = await coordinator.beginOpaqueUpload(path, options);
  try {
    await store.putIfAbsent(reservation.objectKey, body, {
      ...(reservation.contentType === undefined ? {} : { contentType: reservation.contentType }),
    });
    return await coordinator.commitOpaqueUpload(reservation.uploadId, {
      ...(options.verifiedSha256 === undefined
        ? {}
        : { verifiedSha256: options.verifiedSha256 }),
    });
  } catch (error) {
    await coordinator.abortOpaqueUpload(reservation.uploadId);
    throw error;
  }
}

export async function readOpaque(
  fileSystem: Pick<VirtualFileSystem, "resolveOpaqueRead">,
  store: OpaqueStore,
  path: string,
  range?: Parameters<OpaqueStore["getStream"]>[1],
  leaseMs?: number,
): Promise<{ stat: OpaqueFileStat; stream: ReadableStream<Uint8Array> }> {
  const lease = await fileSystem.resolveOpaqueRead(path, leaseMs);
  const stream = await store.getStream(lease.object.key, range);
  if (stream === null) {
    throw new VfsError("EIO", "opaque R2 object is missing", lease.stat.path);
  }
  return { stat: lease.stat, stream };
}
