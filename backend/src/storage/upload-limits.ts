// One GiB per file; the HTTP body includes a small multipart envelope.
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;
