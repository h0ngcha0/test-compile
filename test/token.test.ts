import { web3, Project, TestContractParams, addressFromContractId, AssetOutput, DUST_AMOUNT, hexToString, ONE_ALPH } from '@alephium/web3'
import { expectAssertionError, randomContractId, testAddress, testNodeWallet } from '@alephium/web3-test'
import { deployToDevnet } from '@alephium/cli'
import { Destroy, Foo, TokenFaucet, TokenFaucetTypes, Withdraw } from '../artifacts/ts'

describe('unit tests', () => {
  let testContractId: string
  let testTokenId: string
  let testContractAddress: string
  let testParamsFixture: TestContractParams<TokenFaucetTypes.Fields, { amount: bigint }>

  // We initialize the fixture variables before all tests
  beforeAll(async () => {
    web3.setCurrentNodeProvider('http://127.0.0.1:22973', undefined, fetch)
    await Project.build()
    testContractId = randomContractId()
    testTokenId = testContractId
    testContractAddress = addressFromContractId(testContractId)
    testParamsFixture = {
      // a random address that the test contract resides in the tests
      address: testContractAddress,
      // assets owned by the test contract before a test
      initialAsset: { alphAmount: 10n ** 18n, tokens: [{ id: testTokenId, amount: 10n }] },
      // initial state of the test contract
      initialFields: {
        symbol: Buffer.from('TF', 'utf8').toString('hex'),
        name: Buffer.from('TokenFaucet', 'utf8').toString('hex'),
        decimals: 18n,
        supply: 10n ** 18n,
        balance: 10n
      },
      // arguments to test the target function of the test contract
      testArgs: { amount: 1n },
      // assets owned by the caller of the function
      inputAssets: [{ address: testAddress, asset: { alphAmount: 10n ** 18n } }]
    }
  })

  it('test withdraw', async () => {
    const testParams = testParamsFixture
    const testResult = await TokenFaucet.tests.withdraw(testParams)

    // only one contract involved in the test
    const contractState = testResult.contracts[0] as TokenFaucetTypes.State
    expect(contractState.address).toEqual(testContractAddress)
    expect(contractState.fields.supply).toEqual(10n ** 18n)
    // the balance of the test token is: 10 - 1 = 9
    expect(contractState.fields.balance).toEqual(9n)
    // double check the balance of the contract assets
    expect(contractState.asset).toEqual({ alphAmount: 10n ** 18n, tokens: [{ id: testTokenId, amount: 9n }] })

    // three transaction outputs in total
    expect(testResult.txOutputs.length).toEqual(3)

    // the first transaction output is for the token
    const tokenOutput = testResult.txOutputs[0] as AssetOutput
    expect(tokenOutput.type).toEqual('AssetOutput')
    expect(tokenOutput.address).toEqual(testAddress)
    expect(tokenOutput.alphAmount).toEqual(DUST_AMOUNT) // dust amount
    // the caller withdrawn 1 token from the contract
    expect(tokenOutput.tokens).toEqual([{ id: testTokenId, amount: 1n }])

    // the second transaction output is for the ALPH
    const alphOutput = testResult.txOutputs[1] as AssetOutput
    expect(alphOutput.type).toEqual('AssetOutput')
    expect(alphOutput.address).toEqual(testAddress)
    expect(alphOutput.alphAmount).toBeLessThan(10n ** 18n) // the caller paid gas
    expect(alphOutput.tokens).toEqual([])

    // the third transaction output is for the contract
    const contractOutput = testResult.txOutputs[2]
    expect(contractOutput.type).toEqual('ContractOutput')
    expect(contractOutput.address).toEqual(testContractAddress)
    expect(contractOutput.alphAmount).toEqual(10n ** 18n)
    // the contract has transferred 1 token to the caller
    expect(contractOutput.tokens).toEqual([{ id: testTokenId, amount: 9n }])

    // a `Withdraw` event is emitted when the test passes
    expect(testResult.events.length).toEqual(1)
    const event = testResult.events[0] as TokenFaucetTypes.WithdrawEvent
    // the event is emitted by the test contract
    expect(event.contractAddress).toEqual(testContractAddress)
    // the name of the event is `Withdraw`
    expect(event.name).toEqual('Withdraw')
    // the first field of the event
    expect(event.fields.to).toEqual(testAddress)
    // the second field of the event
    expect(event.fields.amount).toEqual(1n)

    // the test framework support debug messages too
    // debug will be disabled automatically at the deployment to real networks
    expect(testResult.debugMessages).toEqual([
      { contractAddress: testContractAddress, message: 'The current balance is 10' }
    ])
  })

  it('test withdraw', async () => {
    const testParams = { ...testParamsFixture, testArgs: { amount: 3n } }
    // test that assertion failed in the withdraw function
    await expectAssertionError(TokenFaucet.tests.withdraw(testParams), testContractAddress, 0)
  })
})

describe('integration tests', () => {
  beforeAll(async () => {
    web3.setCurrentNodeProvider('http://127.0.0.1:22973', undefined, fetch)
    await Project.build()
  })

  it('should withdraw on devnet', async () => {
    const signer = await testNodeWallet()
    const deployments = await deployToDevnet()

    // Test with all of the addresses of the wallet
    for (const account of await signer.getAccounts()) {
      const testAddress = account.address
      await signer.setSelectedAccount(testAddress)
      const testGroup = account.group

      const deployed = deployments.getDeployedContractResult(testGroup, 'TokenFaucet')
      if (deployed === undefined) {
        console.log(`The contract is not deployed on group ${account.group}`)
        continue
      }
      const tokenId = deployed.contractInstance.contractId
      const tokenAddress = deployed.contractInstance.address
      expect(deployed.contractInstance.groupIndex).toEqual(testGroup)

      const faucet = TokenFaucet.at(tokenAddress)
      const initialState = await faucet.fetchState()
      const initialBalance = initialState.fields.balance

      const symbol = await faucet.methods.getSymbol()
      expect(symbol.returns).toEqual(Buffer.from('TF', 'utf8').toString('hex'))


      // Call `withdraw` function 5 times
      for (let i = 0; i < 5; i++) {
        await Withdraw.execute(signer, {
          initialFields: { token: tokenId, amount: 1n },
          attoAlphAmount: DUST_AMOUNT * 2n
        })

        const newState = await faucet.fetchState()
        const newBalance = newState.fields.balance
        expect(newBalance).toEqual(initialBalance - BigInt(i) - 1n)
      }
    }
  }, 20000)

  it('should destroy on devnet', async () => {
    const signer = await testNodeWallet()
    const account = await signer.getSelectedAccount()
    const deploymentResult = await Foo.deploy(signer, { initialFields: { owner: account.address } })
    const fooContractId = deploymentResult.contractInstance.contractId
    const { balance: beforeBalance } = await signer.nodeProvider.addresses.getAddressesAddressBalance(account.address)
    const destroyResult = await Destroy.execute(signer, {
      initialFields: { contract: fooContractId }
    })
    const destroyGasFee = BigInt(destroyResult.gasAmount) * BigInt(destroyResult.gasPrice)
    const { balance: afterBalance } = await signer.nodeProvider.addresses.getAddressesAddressBalance(account.address)
    expect(BigInt(afterBalance)).toEqual(BigInt(beforeBalance) + ONE_ALPH / 10n - destroyGasFee)
  })
})
