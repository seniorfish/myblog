/** Serialize a value for safe embedding inside a `<script>` tag. */
export function serializeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
