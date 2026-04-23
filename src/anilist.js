const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export async function fetchAniList(query, variables) {
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`anilist HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`anilist errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}
