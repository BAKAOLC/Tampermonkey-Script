// ==UserScript==
// @license MIT
// @name        Pixiv AI Tag
// @description 对Pixiv中的AI生成图像添加一个标注
// @author      BAKAOLC
// @version     0.3
// @icon        http://www.pixiv.net/favicon.ico
// @match       *://www.pixiv.net/*
// @namespace   none
// @grant       none
// @supportURL  https://github.com/BAKAOLC/Tampermonkey-Script
// @homepageURL https://github.com/BAKAOLC/Tampermonkey-Script
// @noframes
// ==/UserScript==

let config = {
    //查询间隔，时间单位为毫秒，0代表无延时
    query_delay: 0,
    /*是否移除AI作品的预览图
    * 0 不移除
    * 1 仅屏蔽图像显示
    * 2 从网页中移除
    */
    remove_image: 0,
};

const common_selector = "div.sc-k3uf3r-8>div>div>div>div>a";
const selector = [
    {
        url: /pixiv.net\/(cate_r18|manga|en\/$|$)/,
        sel: "ul div>div>div:nth-of-type(1)>a",
        parent: 4,
    },
    {
        url: /pixiv.net\/(en\/)?artworks/,
        sel: "ul div>div>div>a, main nav div>div>div>a",
        parent: 4,
    },
    {
        url: "pixiv.net/bookmark_new_illust",
        sel: "ul div>div>div>a",
        parent: 4,
    },
    {
        url: "pixiv.net/contest",
        sel: ".thumbnail-container>a",
        parent: 0,
    },
    {
        url: "pixiv.net/discovery",
        sel: "ul div>div>div:nth-of-type(1)>a",
        parent: 4,
    },
    {
        url: "pixiv.net/new_illust",
        sel: "ul div>div:nth-of-type(1)>div>a",
        parent: 4,
    },
    {
        url: "pixiv.net/ranking",
        sel: ".ranking-image-item>a",
        parent: 0,
    },
    {
        url: /pixiv.net\/request($|\/(complete|creators)\/(illust|manga|ugoira))/,
        sel: "ul div>div:nth-of-type(1)>a",
        parent: 4,
    },
    {
        url: /pixiv.net\/(en\/)?tags/,
        sel: "ul div>div>div>a",
        parent: 4,
    },
    {
        url: /pixiv.net\/(en\/)?users/,
        sel: "ul div>div:nth-of-type(1)>div:nth-of-type(1)>a, ul div>div div>div:nth-of-type(1)>a:nth-child(1)",
        parent: 4,
    },
    {
        url: /pixiv.net\/user\/\d+\/series\/\d+/,
        sel: "ul div>div>div>a",
        parent: 4,
    },
];
const parent_list = ["sc-7uv8pt-1, sc-l7cibp-2, sc-xsxgxe-0"]

let query_array = [];
let query_record = {};
(function () {
    add_style();
    selector.map(
        (rule) =>
        (rule.sel = (rule.sel + ", " + common_selector)
            .split(",")
            .map((n) => n + `[href*="/artworks/"]:not(.add_ai_tag)`)
            .join(","))
    );
    start_interval();
    new MutationObserver(function () {
        let rule = selector.find((s) => location.href.match(s.url));
        let illusts = rule ? document.querySelectorAll(rule.sel) : [];
        if (illusts.length) add_ai_tag_delay(illusts, rule.parent);
    }).observe(document.body, { childList: true, subtree: true });
})();

function add_style() {
    document.head.insertAdjacentHTML("beforeend", `
<style id="css_add_ai_tag">
.add_ai_tag_view {
    padding: 0px 6px;
    border-radius: 3px;
    color: rgb(255, 255, 255);
    background: rgb(96, 64, 255);
    font-weight: bold;
    font-size: 10px;
    line-height: 16px;
    user-select: none;
}
</style>
`);
}

function start_interval() {
    if (config.query_delay > 0) {
        setInterval(async function () {
            if (query_array.length > 0) {
                let data = query_array.shift();
                query_illust(data.id, data.node, data.depth);
            }
        }, config.query_delay);
    }
    else {
        setInterval(async function () {
            while (query_array.length > 0) {
                let data = query_array.shift();
                query_illust(data.id, data.node, data.depth);
            }
        }, 100);
    }
}

async function add_ai_tag_delay(illusts, parent_depth) {
    illusts.forEach(async (a) => {
        a.classList.add("add_ai_tag");
        let id = a.href.split("/artworks/").pop();
        query_array.push({
            id: id,
            node: a,
            depth: parent_depth,
        });
    });
}

async function query_illust(id, node, depth) {
    if (!query_record[id]) {
        let json = await (
            await fetch(
                "https://www.pixiv.net/ajax/illust/" + id,
                { credentials: "omit" }
            )
        ).json();
        query_record[id] = json.body.aiType == 2;
    }
    if (query_record[id]) {
        add_ai_tag_view(node, depth);
    }
}

function getParentNodeWithDepth(node, depth) {
    while (depth > 0) {
        if (node.parentNode)
            node = node.parentNode;
        else
            return null;
        depth--;
    }
    return node;
}

function add_ai_tag_view(node, depth) {
    try {
        switch (config.remove_image) {
            case 1:
                node.querySelector("div>img").outerHTML = "<h5>AI Artwork</h5>";
                break;
            case 2:
                var parent = getParentNodeWithDepth(node, depth ?? 0);
                if (parent) {
                    var parent2 = parent.parentNode;
                    if (parent2) {
                        parent2.removeChild(parent);
                    }
                }
                return;
        }
    } catch { };
    let div12 = node.querySelector("div.sc-rp5asc-12");
    if (div12) {
        let div13 = div12.querySelector("div.sc-rp5asc-13");
        if (!div13) {
            div12.insertAdjacentHTML("afterbegin", `<div class="sc-rp5asc-13 liXhix"></div>`);
            div13 = div12.querySelector("div.sc-rp5asc-13");
        }
        div13.insertAdjacentHTML("afterbegin", `<div class="sc-1ovn4zb-0 add_ai_tag_view">AI</div>`);
    }
}