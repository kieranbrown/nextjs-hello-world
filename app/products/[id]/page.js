async function getProducts() {
  return fetch('https://dummyjson.com/products')
    .then(res => res.json())
    .then(data => data.products);
}

async function getProduct(params) {
  return fetch(`https://dummyjson.com/products/${params.id}`, { next: { revalidate: 60 } })
    .then(res => res.json());
}

export async function generateStaticParams() {
  const products = (await getProducts()).slice(0, 10);

  return products.map((product) => ({ id: product.id.toString() }));
}

export default async function Page({ params }) {
  const product = await getProduct(params);

  return (
    <div>
      <div>{product.title}</div>
      <div>{product.id}</div>
    </div>
  );
}
