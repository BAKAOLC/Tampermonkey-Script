// ==UserScript==
// @license MIT
// @name        Skeb 关注列表信息增强
// @description 在 Skeb 关注列表中添加当前约稿开放状态
// @author      BAKAOLC
// @version     0.0.1
// @match     *://skeb.jp/following_users
// @namespace   none
// @grant       GM.xmlHttpRequest
// @noframes
// ==/UserScript==

const selector = "#root>main>div>div>section>div>div>a:not(.skeb_query_node)";

const query_dict = {};

function query_document() {
    const urls = document.querySelectorAll(selector);
    urls.forEach(add_query_node);
}

function add_query_node(node) {
    node.classList.add("skeb_query_node");
    if (node.href && node.href.match(/\/@([^/]+)/)) {
        const id = node.href.match(/\/@([^/]+)/)[1];
        console.log("skeb_query_node", id);
        if (query_dict[id] === undefined) {
            query_dict[id] = {
                nodes: [],
                request_info: null,
                working: false,
            };
        }
        query_dict[id].nodes.push(node);
    }
}

async function query_task() {
    let has_request = false;
    for (const id in query_dict) {
        if (query_dict[id].nodes.length > 0 && !query_dict[id].working) {
            const nodes = query_dict[id].nodes;
            query_dict[id].nodes = [];
            query_dict[id].working = true;
            has_request = await query_skeb_user(id, nodes);
            query_dict[id].working = false;
            if (has_request) {
                break;
            }
        }
    }
}

(function () {
    apply_style();
    query_document();
    new MutationObserver(query_document).observe(document.body, { childList: true, subtree: true });
    setInterval(query_task, 100);
})();

function apply_query_skeb_user_request_info(nodes, user_id, request_info) {
    nodes.forEach(node => add_request_info(node, user_id, request_info));
}

async function query_skeb_user(id, nodes) {
    if (query_dict[id].request_info === null) {
        console.log("query_skeb_user", id);
        GM.xmlHttpRequest({
            method: "GET", url: `https://skeb.jp/api/users/${id}`,
            headers: {
                ["authority"]: "skeb.jp",
                ["pragma"]: "no-cache",
                ["cache-control"]: "no-cache",
                ["sec-ch-ua"]: `" Not A;Brand";v="99", "Chromium";v="99", "Microsoft Edge";v="99"`,
                ["accept"]: "application/json, text/plain, */*",
                ["dnt"]: "1",
                ["authorization"]: "Bearer null",
                ["sec-ch-ua-mobile"]: "?0",
                ["user-agent"]: navigator.userAgent,
                ["sec-ch-ua-platform"]: `"Windows"`,
                ["sec-fetch-site"]: "same-origin",
                ["sec-fetch-mode"]: "cors",
                ["sec-fetch-dest"]: "empty",
                ["referer"]: "https://skeb.jp/",
                ["accept-language"]: "zh-CN,zh;q=0.9,en;q=0.8",
            },
            onload: function (xhr) {
                const json = JSON.parse(xhr.responseText);
                console.log(json);
                const acceptable = json.acceptable || false;
                const nsfw = json.nsfw_acceptable || false;
                const skills = json.skills || [];
                const art_skill = skills.find(skill => skill.genre === "art");
                let request_info;
                if (!acceptable) {
                    request_info = "没有开放约稿";
                } else if (!art_skill) {
                    request_info = "没有绘画约稿技能";
                } else {
                    request_info = `开放约稿: ${art_skill.default_amount} NSFW: ${nsfw ? "OK" : "NG"}`;
                }
                apply_query_skeb_user_request_info(nodes, id, request_info);
            }
        });
        return true;
    } else {
        apply_query_skeb_user_request_info(nodes, id, query_dict[id].request_info);
        return false;
    }
}

function add_request_info(node, user_id, request_info) {
    if (node.tag_request_info_added) return;
    node.tag_request_info_added = true;
    const node_username = node.querySelector(".username");
    if (!node_username) return;
    const node_parent = node_username.parentNode;
    if (!node_parent) return;
    node_parent.classList.add("is-narrow");
    const node_info = create_info_node(user_id, request_info);
    node_parent.after(node_info);
}

function create_info_node(user_id, request_info) {
    const outerDiv = document.createElement("div");
    outerDiv.style.display = "flex";
    outerDiv.style.color = "rgb(29, 155, 240)";
    outerDiv.classList.add("column", "skeb-query-37j5jr", "skeb-query-a023e6", "skeb-query-16dba41", "skeb-query-rjixqe", "skeb-query-bcqeeo", "skeb-query-qvutc0");
    const firstAnchor = document.createElement("a");
    firstAnchor.href = "https://skeb.jp";
    firstAnchor.style.display = "flex";
    firstAnchor.style.alignItems = "center";
    firstAnchor.target = "_blank";
    firstAnchor.role = "link";
    firstAnchor.setAttribute("data-focusable", "true");
    firstAnchor.classList.add("skeb-query-1loqt21", "skeb-query-4qtqp9", "skeb-query-bcqeeo", "skeb-query-qvutc0");
    firstAnchor.rel = "noopener noreferrer";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.classList.add("skeb-query-4qtqp9", "skeb-query-yyyyoo", "skeb-query-1xvli5t", "skeb-query-dnmrzs", "skeb-query-bnwqim");
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const rect1 = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect1.setAttribute("x", "7.59");
    rect1.setAttribute("y", "4.44");
    rect1.setAttribute("transform", "matrix(0.3231 -0.9464 0.9464 0.3231 0.3479 11.7668)");
    rect1.setAttribute("width", "1.61");
    rect1.setAttribute("height", "2.41");
    const rect2 = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect2.setAttribute("x", "6.04");
    rect2.setAttribute("y", "9");
    rect2.setAttribute("transform", "matrix(0.3231 -0.9464 0.9464 0.3231 -5.0223 13.3813)");
    rect2.setAttribute("width", "1.61");
    rect2.setAttribute("height", "2.41");
    const rect3 = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect3.setAttribute("x", "4.48");
    rect3.setAttribute("y", "13.56");
    rect3.setAttribute("transform", "matrix(0.3231 -0.9464 0.9464 0.3231 -10.3938 14.9961)");
    rect3.setAttribute("width", "1.61");
    rect3.setAttribute("height", "2.41");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M12,0C5.37,0,0,5.37,0,12s5.37,12,12,12s12-5.37,12-12S18.63,0,12,0z M13.76,4.98L8,21.88 c-0.4-0.16-0.78-0.35-1.16-0.55l4.43-12.9l0.03-0.1l1.06-3.12l0.23-0.69L9.56,3.5L9.3,4.25l1.52,0.52L9.79,7.81L8.26,7.29 L7.74,8.81l1.52,0.52l-1.03,3.04l-1.52-0.52l-0.54,1.52l1.52,0.52l-1.03,3.04l-1.52-0.51l-0.51,1.53l1.52,0.52l-0.68,1.96 c-0.23-0.18-0.45-0.36-0.66-0.56l0.34-0.9l-1.68-0.57C2.13,16.6,1.34,14.39,1.34,12C1.34,6.11,6.11,1.34,12,1.34 c4.37,0,8.12,2.63,9.76,6.38L13.76,4.98z");
    g.appendChild(rect1);
    g.appendChild(rect2);
    g.appendChild(rect3);
    g.appendChild(path);
    svg.appendChild(g);
    firstAnchor.appendChild(svg);
    const secondAnchor = document.createElement("a");
    secondAnchor.href = `https://skeb.jp/@${user_id}`;
    secondAnchor.style.display = "flex";
    secondAnchor.style.alignItems = "center";
    secondAnchor.style.lineHeight = "1";
    secondAnchor.target = "_blank";
    secondAnchor.role = "link";
    secondAnchor.setAttribute("data-focusable", "true");
    secondAnchor.rel = "noopener noreferrer";
    const strong = document.createElement("strong");
    strong.style.marginLeft = "4px";
    strong.textContent = request_info;
    secondAnchor.appendChild(strong);
    outerDiv.appendChild(firstAnchor);
    outerDiv.appendChild(secondAnchor);
    return outerDiv;
}

function apply_style() {
    const style = document.createElement("style");
    style.textContent = `
.skeb-query-qvutc0 {
  word-wrap: break-word;
}
.skeb-query-1loqt21 {
  cursor: pointer;
}
.skeb-query-37j5jr {
  font-family: TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.skeb-query-rjixqe {
  line-height: 20px;
}
.skeb-query-bcqeeo {
  min-width: 0px;
}
.skeb-query-a023e6 {
  font-size: 15px;
}
.skeb-query-16dba41 {
  font-weight: 400;
}
.skeb-query-dnmrzs {
  max-width: 100%;
}
.skeb-query-bnwqim {
  position: relative;
}
.skeb-query-1xvli5t {
  height: 1.25em;
}
.skeb-query-4qtqp9 {
  display: inline-block;
}
.skeb-query-yyyyoo {
    fill: currentcolor;
}
`;
    document.head.appendChild(style);
}