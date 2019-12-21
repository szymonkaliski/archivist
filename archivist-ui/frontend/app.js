const React = require("react");
const ReactDOM = require("react-dom");
const { Grid, AutoSizer } = require("react-virtualized");
const { chain } = require("lodash");

const { useState, useEffect } = React;

const { spawn } = require("child_process");
const talkToProcess = async (command, args) => {
  return new Promise(resolve => {
    const process = spawn(
      "node",
      args ? ["./process.js", command, args] : ["./process.js", command]
    );

    let data = "";

    process.stdout.on("data", d => {
      data += d.toString();
    });

    process.stderr.on("data", data => {
      console.log("[stderr]", data.toString());
    });

    process.on("exit", () => {
      resolve(JSON.parse(data));
    });
  });
};

const Item = ({ img, link }) => {
  return (
    <div className="h-100 pa2">
      <div
        className="h-100"
        style={{
          backgroundImage: `url("${img}")`,
          backgroundSize: "contain",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center"
        }}
      />
    </div>
  );
};

const createCellRenderer = ({ data, columnCount }) => ({
  columnIndex,
  rowIndex,
  key,
  style
}) => {
  const index = columnIndex + rowIndex * columnCount;
  const hasData = !!data[index];

  return (
    <div key={key} style={style}>
      {hasData ? <Item {...data[index]} /> : null}
    </div>
  );
};

const calcCellSize = ({ width }) => {
  return width / Math.floor(width / 500);
};

const App = () => {
  const [data, setData] = useState([]);

  useEffect(() => {
    talkToProcess("query").then(data => {
      const finalData = chain(data)
        .map(d => ({ ...d, time: new Date(d.time) }))
        .sortBy(d => d.time)
        .reverse()
        .value();

      setData(finalData);

      console.log(finalData);
    });
  }, []);

  return (
    <div className="sans-serif w-100 vh-100 bg-light-gray">
      <AutoSizer>
        {({ width, height }) => {
          const cellSize = calcCellSize({ width, height });
          const columnCount = Math.max(width / cellSize, 1);
          const cellRenderer = createCellRenderer({ data, columnCount });

          return (
            <Grid
              cellRenderer={cellRenderer}
              columnCount={columnCount}
              columnWidth={cellSize}
              rowHeight={(cellSize * 9) / 16}
              rowCount={Math.ceil(data.length / columnCount)}
              height={height}
              width={width}
            />
          );
        }}
      </AutoSizer>
    </div>
  );
};

ReactDOM.render(<App />, document.getElementById("app"));
