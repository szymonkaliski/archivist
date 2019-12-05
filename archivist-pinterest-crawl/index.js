const crawler = require("./crawler");

const SAMPLE_RESULTS = [
  {
    url: "https://pl.pinterest.com/pin/393994667394421206/",
    src:
      "https://i.pinimg.com/236x/05/4c/0d/054c0d47ed6df48dbaf5da4b787e252a.jpg",
    alt: "IBM Design's contact form More",
    board: "design",
    detail: {
      pinUrl: "https://pl.pinterest.com/pin/393994667394421206/",
      imgSrc:
        "https://i.pinimg.com/236x/05/4c/0d/054c0d47ed6df48dbaf5da4b787e252a.jpg",
      imgAlt: "IBM Design's contact form More",
      linkHref: "https://www.ibm.com/design/"
    }
  }
];

const run = async () => {
  // const results = await crawler();
  const results = SAMPLE_RESULTS;

  console.log(results);
};

run();
