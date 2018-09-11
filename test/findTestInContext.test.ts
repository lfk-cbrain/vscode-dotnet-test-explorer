import * as assert from "assert";
import * as path from "path";
import { Location, Position, Range, SymbolInformation, SymbolKind, Uri, workspace } from "vscode";
import { FindTestInContext } from "../src/findTestInContext";

suite("Find test in context tests", () => {

    test("One symbol", async () => {

        const findTestInContext = new FindTestInContext();

        const symbols = [
            new SymbolInformation("MyClass", SymbolKind.Class, "", new Location(Uri.file("c:/"), new Range(new Position(5, 1), new Position(200, 1)))),
        ];

        const result = await findTestInContext.getTestString(symbols, 10, "");

        assert.equal(result.testName, "MyClass");
        assert.equal(result.isSingleTest, false);
    });

    test("Only symbols of type class and methods are found", async () => {

        const findTestInContext = new FindTestInContext();

        const symbols = [
            new SymbolInformation("MyClass", SymbolKind.Class, "", new Location(Uri.file("c:/"), new Range(new Position(5, 1), new Position(5, 5)))),
            new SymbolInformation("MyClass", SymbolKind.Constructor, "MyClass", new Location(Uri.file("c:/"), new Range(new Position(8, 1), new Position(8, 8)))),
            new SymbolInformation("Myproperty", SymbolKind.Property, "MyClass", new Location(Uri.file("c:/"), new Range(new Position(16, 1), new Position(16, 16)))),
        ];

        const result = await findTestInContext.getTestString(symbols, 16, "");

        assert.equal(result.testName, "MyClass");
        assert.equal(result.isSingleTest, false);
    });

    test("Multiple symbols, match closest in context", async () => {

        const findTestInContext = new FindTestInContext();

        const symbols = [
            new SymbolInformation("MyClass", SymbolKind.Class, "", new Location(Uri.file("c:/"), new Range(new Position(5, 1), new Position(5, 7)))),
            new SymbolInformation("TestMethod", SymbolKind.Method, "MyClass", new Location(Uri.file("c:/"), new Range(new Position(8, 1), new Position(8, 11)))),
            new SymbolInformation("TestMethod2", SymbolKind.Method, "MyClass", new Location(Uri.file("c:/"), new Range(new Position(15, 1), new Position(15, 11)))),
        ];

        assert.equal(findTestInContext.getTestString(symbols, 8, "").testName, "MyClass.TestMethod");
        assert.equal(findTestInContext.getTestString(symbols, 8, "").isSingleTest, true);

        assert.equal(findTestInContext.getTestString(symbols, 14, "").testName, "MyClass.TestMethod");
        assert.equal(findTestInContext.getTestString(symbols, 14, "Namespace").testName, "Namespace.MyClass.TestMethod");

        assert.equal(findTestInContext.getTestString(symbols, 15, "").testName, "MyClass.TestMethod2");
        assert.equal(findTestInContext.getTestString(symbols, 1000, "").testName, "MyClass.TestMethod2");
        assert.equal(findTestInContext.getTestString(symbols, 1000, "Name.Space").testName, "Name.Space.MyClass.TestMethod2");

        assert.equal(findTestInContext.getTestString(symbols, 5, "").testName, "MyClass");
        assert.equal(findTestInContext.getTestString(symbols, 6, "").testName, "MyClass");
        assert.equal(findTestInContext.getTestString(symbols, 1, "").testName, "MyClass");
        assert.equal(findTestInContext.getTestString(symbols, 1, "Name.Space").testName, "Name.Space.MyClass");
    });
});

suite("Find namespace tests", () => {

    test("Find namespace", async () => {
        const fixturePath = path.join(__dirname, "..", "..", "test", "xunittests", "TestClass1.cs");
        const findTestInContext = new FindTestInContext();

        await workspace.openTextDocument(Uri.file(fixturePath)).then((textDocument) => {
            const fileContent = textDocument.getText();
            const result = findTestInContext.getNamespace(fileContent);

            assert.equal(result, "XunitTests");
        });
    });

    test("Find namespace with curly brancket on same line", async () => {
        const fixturePath = path.join(__dirname, "..", "..", "test", "mstest", "TestClass1.cs");
        const findTestInContext = new FindTestInContext();

        await workspace.openTextDocument(Uri.file(fixturePath)).then((textDocument) => {
            const fileContent = textDocument.getText();
            const result = findTestInContext.getNamespace(fileContent);

            assert.equal(result, "MsTestTests");
        });
    });
});
