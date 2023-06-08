export const runtime = 'edge';

async function getProducts() {
  return fetch('https://dummyjson.com/products')
    .then(res => res.json())
    .then(data => data.products);
}

async function getProduct(params) {
  return fetch(`https://dummyjson.com/products/${params.id}`, { next: { revalidate: 60 } })
    .then(res => {
      console.log(res);
      return res.json();
    });
}

export async function generateStaticParams() {
  const products = (await getProducts()).slice(0, 10); // first 10 products are generated statically at build time

  return products.map((product) => ({ id: product.id.toString() }));
}

export default async function Page({ params }) {
  const product = await getProduct(params);

  return (
    <div>
      <div>title: {product.title}</div>
      <div>id: {product.id}</div>
    </div>
  );
}
