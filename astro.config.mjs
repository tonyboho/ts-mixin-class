import { defineConfig } from "astro/config"

export default defineConfig({
    site : "https://tonyboho.github.io",
    base : "/ts-mixin-class",

    markdown : {
        shikiConfig : {
            themes : { light : "github-light", dark : "github-dark" }
        }
    }
})
