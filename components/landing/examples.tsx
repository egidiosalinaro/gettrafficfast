import Link from "next/link";
import { listPosts } from "@/lib/blog/posts";

/**
 * Examples, with a rule: every article shown here is a real published article
 * from this site's own blog, written by the pipeline a customer would pay for.
 *
 * The previous version listed four invented titles pointing at "#". A visitor
 * who clicks an example and lands nowhere has learned something true about the
 * product, just not the thing the section intended.
 */
async function loadSafely() {
  try {
    return await listPosts(4);
  } catch (error) {
    console.error("examples: could not load blog posts", error);
    return [];
  }
}

export async function Examples() {
  const posts = await loadSafely();

  return (
    <section id="examples" className="w-full max-w-[1200px] mx-auto px-5 py-20">
      <div className="text-center mb-16">
        <h2 className="text-4xl font-bold mb-4">Articles it wrote for itself</h2>
        <p className="text-xl text-foreground/70 max-w-3xl mx-auto">
          GetTrafficFast is its own customer: this site&rsquo;s blog is written
          by the same agent, on the same schedule, with no editing pass a
          customer would not get.
        </p>
      </div>

      {posts.length > 0 ? (
        <>
          <div className="grid md:grid-cols-2 gap-6 mb-8">
            {posts.map((post) => (
              <Link
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="p-6 rounded-lg border bg-card hover:shadow-lg transition"
              >
                {post.date && (
                  <time className="text-xs text-muted-foreground">{post.date}</time>
                )}
                <h3 className="text-xl font-semibold mb-2 mt-1">{post.title}</h3>
                <p className="text-sm text-foreground/70 line-clamp-3">{post.excerpt}</p>
              </Link>
            ))}
          </div>
          <p className="text-center text-sm text-muted-foreground">
            More on{" "}
            <Link href="/blog" className="underline hover:opacity-70">
              the blog
            </Link>
            , where every post arrived the same way yours would.
          </p>
        </>
      ) : (
        <div className="max-w-[640px] mx-auto rounded-lg border p-6 text-center">
          <p className="text-foreground/70 mb-2">
            Nothing published here yet.
          </p>
          <p className="text-sm text-muted-foreground">
            The samples that used to sit here were invented, so they are gone.
            Real articles appear as soon as the pipeline starts writing for this
            domain, and they will be the same ones the{" "}
            <Link href="/blog" className="underline hover:opacity-70">
              blog
            </Link>{" "}
            publishes.
          </p>
        </div>
      )}
    </section>
  );
}
