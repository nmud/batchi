export const pretty = (obj: unknown) => JSON.stringify(obj, null, 2);

export function section(title: string) {
  console.log("");
  console.log(title);
}

export function kv(label: string, value?: string | number | null) {
  if (value === undefined || value === null || value === "") return;
  console.log(`${label}: ${value}`);
}
